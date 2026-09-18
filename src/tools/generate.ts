import { createGenerationBackend, type GenerationBackendName, type VideoGenerationRequest } from "../backends/generation.js";

/** Descripteurs listTools et adaptateur callTool ; enregistrement explicite requis
 * dans le serveur hôte. Aucun accès Studio, base ou génération distante par défaut.
 */
export const generateTools = [
  { name: "generate_shot", description: "Prepare an existing local rush (the default, no key), or explicitly call Azure Sora.", inputSchema: {
    type: "object", properties: {
      backend: { type: "string", enum: ["local", "azure-sora"], default: "local" },
      source: { type: "string", description: "Rush local relatif à ATELIER_WORK_DIR." },
      prompt: { type: "string" }, seconds: { type: "string", enum: ["4", "8", "12"] },
      size: { type: "string", enum: ["1280x720", "720x1280", "1024x1792", "1792x1024"] },
    }, additionalProperties: false,
  } },
  { name: "generate_status", description: "State of a generation job; the backend is recovered from the local metadata.", inputSchema: {
    type: "object", properties: {
      id: { type: "string" }, backend: { type: "string", enum: ["local", "azure-sora"] },
    }, required: ["id"], additionalProperties: false,
  } },
  { name: "generate_fetch", description: "Copy or download the finished result into a new local file.", inputSchema: {
    type: "object", properties: {
      id: { type: "string" }, backend: { type: "string", enum: ["local", "azure-sora"] },
      destination: { type: "string", description: "Chemin relatif ; aucun fichier existant n'est écrasé." },
    }, required: ["id", "destination"], additionalProperties: false,
  } },
];
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Arguments JSON objet attendus.");
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
  return value;
}
function backendName(value: unknown): GenerationBackendName | undefined {
  if (value === undefined) return undefined;
  if (value !== "local" && value !== "azure-sora") throw new Error("Connecteur inconnu : local ou azure-sora attendu.");
  return value;
}
/** Exemple sans réseau, avec un rush déjà présent :
 * generate_shot {"source":"rushes/plan.mp4"}
 * generate_status {"id":"<id retourné>"}
 * generate_fetch {"id":"<id retourné>","destination":"assets/plan.mp4"}
 */
export async function callGenerateTool(name: string, args: unknown) {
  try {
    if (!generateTools.some(tool => tool.name === name)) throw new Error("Outil de génération inconnu.");
    const input = object(args);
    const allowed = name === "generate_shot" ? ["backend", "source", "prompt", "seconds", "size"] : name === "generate_status" ? ["backend", "id"] : ["backend", "id", "destination"];
    if (Object.keys(input).some(key => !allowed.includes(key))) throw new Error("Paramètre inconnu pour cet outil.");
    const backend = await createGenerationBackend(backendName(input.backend), name === "generate_shot" ? undefined : text(input.id, "id"));
    let result: unknown;
    switch (name) {
      case "generate_shot": {
        const request: VideoGenerationRequest = {};
        if (input.source !== undefined) request.source = text(input.source, "source");
        if (input.prompt !== undefined) request.prompt = text(input.prompt, "prompt");
        if (input.seconds !== undefined) {
          if (input.seconds !== "4" && input.seconds !== "8" && input.seconds !== "12") throw new Error("seconds : chaîne 4, 8 ou 12 attendue.");
          request.seconds = input.seconds;
        }
        if (input.size !== undefined) {
          if (input.size !== "1280x720" && input.size !== "720x1280" && input.size !== "1024x1792" && input.size !== "1792x1024") throw new Error("Taille Sora invalide.");
          request.size = input.size;
        }
        result = await backend.launch(request); break;
      }
      case "generate_status": result = await backend.status(text(input.id, "id")); break;
      case "generate_fetch": result = await backend.download(text(input.id, "id"), text(input.destination, "destination")); break;
    }
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  } catch (error) {
    // Les erreurs fs/fetch natives peuvent contenir un chemin ou endpoint privé.
    const native = error instanceof Error && ("code" in error || error instanceof TypeError || error.name === "TimeoutError" || error.name === "AbortError");
    const message = native ? "Génération : accès fichier ou réseau impossible. Vérifier chemins relatifs, permissions et configuration du connecteur." : error instanceof Error ? error.message : "Échec de génération.";
    return { isError: true, content: [{ type: "text" as const, text: message }] };
  }
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/** Même API server.tool que src/tools/media.ts ; à appeler au démarrage stdio. */
export function registerGenerate(server: McpServer): void {
  const backend = z.enum(["local", "azure-sora"]).optional();
  server.tool("generate_shot", generateTools[0]!.description, {
    backend, source: z.string().min(1).optional(), prompt: z.string().min(1).optional(),
    seconds: z.enum(["4", "8", "12"]).optional(),
    size: z.enum(["1280x720", "720x1280", "1024x1792", "1792x1024"]).optional(),
  }, async args => callGenerateTool("generate_shot", args));
  server.tool("generate_status", generateTools[1]!.description, {
    backend, id: z.string().uuid(),
  }, async args => callGenerateTool("generate_status", args));
  server.tool("generate_fetch", generateTools[2]!.description, {
    backend, id: z.string().uuid(), destination: z.string().min(1),
  }, async args => callGenerateTool("generate_fetch", args));
}
