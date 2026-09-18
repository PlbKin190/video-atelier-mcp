import { constants } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { workDir, localFile, newWorkFile } from "../tools/media.js";

export type GenerationBackendName = "local" | "azure-sora";
export type VideoSize = "1280x720" | "720x1280" | "1024x1792" | "1792x1024";
export interface VideoGenerationRequest {
  source?: string;
  prompt?: string;
  seconds?: "4" | "8" | "12";
  size?: VideoSize;
}
export interface VideoGenerationJob {
  id: string;
  backend: GenerationBackendName;
  status: string;
}
export interface VideoGenerationBackend {
  launch(request: VideoGenerationRequest): Promise<VideoGenerationJob>;
  status(id: string): Promise<VideoGenerationJob>;
  download(id: string, destination: string): Promise<{ path: string; size: number }>;
}
interface StoredJob { id: string; backend: GenerationBackendName; source?: string; remoteId?: string }

// The generate contract expects relative paths. Actual confinement is shared.
function relativeSource(source: string): string {
  if (!source || path.isAbsolute(source) || source.includes("\0")) throw new Error("Chemin relatif au dossier de travail attendu.");
  const target = path.resolve(workDir, source);
  const relative = path.relative(workDir, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`)) throw new Error("Chemin hors du dossier de travail interdit.");
  return target;
}
function validId(id: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new Error("Invalid generation identifier.");
}
async function save(job: StoredJob): Promise<void> {
  const target = await newWorkFile(`generation/jobs/${job.id}.json`);
  // Random identifier, exclusive file ; no remote composition or database.
  await fs.writeFile(target, JSON.stringify(job), { flag: "wx", mode: 0o600 });
}
async function load(id: string, backend?: GenerationBackendName): Promise<StoredJob> {
  validId(id);
  const job = JSON.parse(await fs.readFile(await localFile(`generation/jobs/${id}.json`), "utf8")) as StoredJob;
  if (job.id !== id || (job.backend !== "local" && job.backend !== "azure-sora") || (backend && job.backend !== backend)) throw new Error("Travail absent ou connecteur incompatible.");
  return job;
}

export class LocalVideoGenerationBackend implements VideoGenerationBackend {
  async launch(request: VideoGenerationRequest): Promise<VideoGenerationJob> {
    if (!request.source) throw new Error("local : source is required (existing footage under ATELIER_WORK_DIR), no key needed.");
    await localFile(relativeSource(request.source));
    const job: StoredJob = { id: randomUUID(), backend: "local", source: request.source };
    await save(job);
    return { id: job.id, backend: "local", status: "completed" };
  }
  async status(id: string): Promise<VideoGenerationJob> {
    const job = await load(id, "local");
    if (!job.source) throw new Error("Rush local manquant.");
    await localFile(relativeSource(job.source));
    return { id, backend: "local", status: "completed" };
  }
  async download(id: string, destination: string): Promise<{ path: string; size: number }> {
    const job = await load(id, "local");
    if (!job.source) throw new Error("Rush local manquant.");
    const source = await localFile(relativeSource(job.source));
    const target = await newWorkFile(destination);
    await fs.copyFile(source, target, constants.COPYFILE_EXCL);
    return { path: destination, size: (await fs.stat(target)).size };
  }
}

/** 2026-09-17 — END-OF-LIFE compatibility connector.
 * Retirement schedule, recorded on 17/09/2026 from the official pages: sora-2
 * leaves the OpenAI API on 24/09/2026; Azure version 2025-12-08 ends on 15/10/2026.
 * The ported contract nevertheless uses api-version=preview, like the source.
 * Source: studio-genai-mcp/src/sora.ts:26-108. Do not select by default.
 */
export class AzureSoraVideoGenerationBackend implements VideoGenerationBackend {
  private config(): { endpoint: string; secret: string } {
    const endpoint = (process.env.AZURE_SORA_ENDPOINT || "").replace(/\/+$/, "");
    const secret = process.env.AZURE_SORA_API_KEY || "";
    if (!endpoint || !secret) throw new Error("azure-sora requires AZURE_SORA_ENDPOINT and AZURE_SORA_API_KEY ; choose local to run without a key.");
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Endpoint Azure HTTPS sans identifiants, query ni fragment attendu.");
    return { endpoint, secret };
  }
  private async request(suffix: string, body?: Record<string, string>): Promise<Response> {
    const { endpoint, secret } = this.config();
    const response = await fetch(`${endpoint}/openai/v1/videos${suffix}?api-version=preview`, {
      method: body ? "POST" : "GET",
      headers: { "api-key": secret, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(300_000),
    });
    // Never copy API bodies/headers: they may contain secrets.
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Azure Sora : HTTP ${response.status}. Connecteur en fin de vie ; local reste disponible.`);
    }
    return response;
  }
  async launch(request: VideoGenerationRequest): Promise<VideoGenerationJob> {
    if (!request.prompt?.trim()) throw new Error("azure-sora : prompt obligatoire.");
    const seconds = request.seconds ?? "4";
    const size = request.size ?? "1280x720";
    if (!["4", "8", "12"].includes(seconds) || !["1280x720", "720x1280", "1024x1792", "1792x1024"].includes(size)) throw new Error("Invalid Sora duration or size.");
    const data = await (await this.request("", {
      model: process.env.AZURE_SORA_DEPLOYMENT || "sora-2", prompt: request.prompt, seconds, size,
    })).json() as Record<string, unknown>;
    if (typeof data.id !== "string" || !data.id || typeof data.status !== "string") throw new Error("Invalid Sora creation response.");
    const job: StoredJob = { id: randomUUID(), backend: "azure-sora", remoteId: data.id };
    await save(job);
    return { id: job.id, backend: job.backend, status: data.status === "succeeded" ? "completed" : data.status };
  }
  async status(id: string): Promise<VideoGenerationJob> {
    const job = await load(id, "azure-sora");
    if (!job.remoteId) throw new Error("Identifiant distant manquant.");
    const data = await (await this.request(`/${encodeURIComponent(job.remoteId)}`)).json() as Record<string, unknown>;
    if (typeof data.status !== "string") throw new Error("Invalid Sora status response.");
    return { id, backend: job.backend, status: data.status === "succeeded" ? "completed" : data.status };
  }
  async download(id: string, destination: string): Promise<{ path: string; size: number }> {
    if ((await this.status(id)).status !== "completed") throw new Error("Generation has not completed successfully.");
    const job = await load(id, "azure-sora");
    if (!job.remoteId) throw new Error("Identifiant distant manquant.");
    const target = await newWorkFile(destination);
    const response = await this.request(`/${encodeURIComponent(job.remoteId)}/content`);
    if (!response.body) throw new Error("Video content missing.");
    let handle;
    try { handle = await fs.open(target, "wx", 0o600); } catch (error) {
      await response.body.cancel(); throw error;
    }
    let size = 0;
    try {
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          let offset = 0;
          while (offset < value.length) {
            const written = await handle.write(value, offset, value.length - offset);
            if (!written.bytesWritten) throw new Error("Video write interrupted.");
            offset += written.bytesWritten;
          }
          size += value.length;
        }
      } finally { await reader.cancel(); reader.releaseLock(); }
      await handle.close();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await fs.unlink(target).catch(() => undefined);
      throw error;
    }
    return { path: destination, size };
  }
}

export async function createGenerationBackend(name?: GenerationBackendName, id?: string): Promise<VideoGenerationBackend> {
  const selected = id ? (await load(id, name)).backend : (name ?? "local");
  if (selected === "local") return new LocalVideoGenerationBackend();
  if (selected === "azure-sora") return new AzureSoraVideoGenerationBackend();
  throw new Error("Connecteur inconnu.");
}
