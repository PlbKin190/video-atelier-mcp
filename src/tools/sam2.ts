import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { access } from "node:fs/promises";
import path from "node:path";
import { initWork, workDir } from "./media.js";

const commands = {
  sam2_segment_image: "segment-image",
  sam2_segment_video: "segment-video",
  sam2_object_track: "track",
  sam2_propagate_mask: "propagate",
  sam2_refine_mask: "refine",
  sam2_screen_replace: "screen-replace",
  sam2_video_inpaint: "inpaint",
} as const;
type ToolName = keyof typeof commands;
const common = {
  input: { type: "string", description: "Fichier relatif à ATELIER_WORK_DIR." },
  output: { type: "string", description: "Destination NOUVELLE relative ; dossier pour masques, .mp4 pour vidéo, .png pour image." },
  points: { type: "array", items: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 }, minItems: 1, maxItems: 256, description: "Points [x,y] sur la première image, en pixels." },
  labels: { type: "array", items: { type: "integer", enum: [0, 1] }, description: "0 fond, 1 objet ; défaut 1 pour chaque point." },
  mask: { type: "string", description: "Masque initial PNG ; propagation approximative par points échantillonnés, pas conditionnement exact du masque." },
  erosion: { type: "integer", minimum: 0, maximum: 31, default: 2 },
  blur: { type: "integer", minimum: 1, maximum: 99, default: 9, description: "Noyau gaussien impair." },
  replacement: { type: "string", description: "Image ou vidéo relative ; une image de remplacement par image source, dernière image répétée si nécessaire." },
};
function descriptor(name: ToolName, description: string, keys: (keyof typeof common)[], required: string[]) {
  return { name, description, inputSchema: {
    type: "object", properties: Object.fromEntries(keys.map(key => [key, common[key]])),
    required, additionalProperties: false,
  } };
}
export const sam2Tools = [
  descriptor("sam2_segment_image", "SAM2: PNG mask for a single image, via the video predictor.", ["input", "output", "points", "labels", "erosion", "blur"], ["input", "output", "points"]),
  descriptor("sam2_segment_video", "SAM2: a series of PNG masks, one per video frame.", ["input", "output", "points", "labels", "erosion", "blur"], ["input", "output", "points"]),
  descriptor("sam2_object_track", "SAM2: masks plus a JSONL track (boxes and centroids) for one object.", ["input", "output", "points", "labels", "erosion", "blur"], ["input", "output", "points"]),
  descriptor("sam2_propagate_mask", "SAM2: approximate propagation, from inside/outside points sampled in the initial mask.", ["input", "output", "mask", "erosion", "blur"], ["input", "output", "mask"]),
  descriptor("sam2_refine_mask", "Refine a PNG mask by erosion and Gaussian blur. Needs only OpenCV and NumPy.", ["input", "output", "erosion", "blur"], ["input", "output"]),
  descriptor("sam2_screen_replace", "SAM2: screen replacement, by mask plus a homography onto the oriented rectangle. Output is muted; perspective is approximate.", ["input", "output", "points", "labels", "replacement", "erosion", "blur"], ["input", "output", "points", "replacement"]),
  descriptor("sam2_video_inpaint", "SAM2 + OpenCV Telea: spatial erasure. No generative model, and no guaranteed temporal consistency. Vidéo muette.", ["input", "output", "points", "labels", "erosion", "blur"], ["input", "output", "points"]),
];
const installHelp = "SAM2 indisponible : utilisez le profil Docker sam2 (docker compose --profile sam2 up). Ce profil doit fournir Python, les dépendances et la distribution SAM2 patchée compatible ; elle n'est pas incluse dans l'image de base.";

/** Descripteurs pour listTools et adaptateur pour callTool, pas un serveur autonome.
 * Le script est à la racine python/, tant depuis src/tools que dist/tools.
 * ATELIER_SAM2_RUNNER et ATELIER_PYTHON sont des réglages administrateur.
 * Aucun shell et aucun stderr Python exposé dans la réponse MCP.
 * Sans torch ni modèle, l'erreur rendue renvoie au profil Docker `sam2`.
 */
async function run(command: string, args: unknown): Promise<unknown> {
  await initWork();
  const root = workDir;
  const runner = process.env.ATELIER_SAM2_RUNNER || fileURLToPath(new URL("../../python/sam2_runner.py", import.meta.url));
  try { await access(runner); } catch { throw new Error(installHelp); }
  const payload = JSON.stringify(args);
  if (!payload || Buffer.byteLength(payload) > 1024 * 1024) throw new Error("Arguments SAM2 absents ou trop volumineux.");
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.ATELIER_PYTHON || "python3", [runner, command], {
      shell: false, cwd: root,
      env: { ...process.env, ATELIER_WORK_DIR: root, HF_HOME: path.join(root, "models") },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    const timer = setTimeout(() => {
      failure = new Error("SAM2 : délai de traitement dépassé (30 minutes).");
      child.kill("SIGKILL");
    }, 30 * 60 * 1000);
    child.stdout.on("data", (data: Buffer) => {
      bytes += data.length;
      if (bytes > 2 * 1024 * 1024) {
        failure = new Error("SAM2 : réponse JSON trop volumineuse."); child.kill("SIGKILL");
      } else chunks.push(data);
    });
    child.stderr.resume();
    child.on("error", () => { clearTimeout(timer); reject(new Error(installHelp)); });
    child.stdin.on("error", () => { /* close/error traite un arrêt avant lecture de stdin. */ });
    child.on("close", code => {
      clearTimeout(timer);
      if (failure) { reject(failure); return; }
      try {
        const result = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { ok?: boolean; error?: { code?: string; message?: string }; result?: unknown };
        if (result.error?.code === "SAM2_UNAVAILABLE") { reject(new Error(installHelp)); return; }
        if (code !== 0 || result.ok !== true) {
          reject(new Error(result.error?.message || "SAM2 : traitement impossible, réponse non valide.")); return;
        }
        resolve(result.result);
      } catch { reject(new Error(code === 0 ? "SAM2 : sortie JSON invalide." : installHelp)); }
    });
    child.stdin.end(payload);
  });
}

export async function callSam2Tool(name: string, args: unknown) {
  try {
    if (!Object.prototype.hasOwnProperty.call(commands, name)) throw new Error("Outil SAM2 inconnu.");
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Arguments JSON objet attendus.");
    const result = await run(commands[name as ToolName], args);
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  } catch (error) {
    return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : "SAM2 : échec." }] };
  }
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/** Enregistrement MCP explicite ; aucune dépendance Python importée au démarrage. */
export function registerSam2(server: McpServer): void {
  const commonShape = {
    input: z.string().min(1), output: z.string().min(1),
    erosion: z.number().int().min(0).max(31).optional(),
    blur: z.number().int().min(1).max(99).refine(value => value % 2 === 1, "Noyau impair requis").optional(),
  };
  const prompted = {
    ...commonShape,
    points: z.array(z.tuple([z.number().finite(), z.number().finite()])).min(1).max(256),
    labels: z.array(z.union([z.literal(0), z.literal(1)])).optional(),
  };
  for (const name of ["sam2_segment_image", "sam2_segment_video", "sam2_object_track", "sam2_video_inpaint"] as const) {
    server.tool(name, sam2Tools.find(tool => tool.name === name)!.description, prompted, async args => callSam2Tool(name, args));
  }
  server.tool("sam2_propagate_mask", sam2Tools[3]!.description, {
    ...commonShape, mask: z.string().min(1),
  }, async args => callSam2Tool("sam2_propagate_mask", args));
  server.tool("sam2_refine_mask", sam2Tools[4]!.description, commonShape,
    async args => callSam2Tool("sam2_refine_mask", args));
  server.tool("sam2_screen_replace", sam2Tools[5]!.description, {
    ...prompted, replacement: z.string().min(1),
  }, async args => callSam2Tool("sam2_screen_replace", args));
}
