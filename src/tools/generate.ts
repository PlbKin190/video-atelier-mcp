import { createGenerationBackend, type GenerationBackendName, type VideoGenerationRequest } from "../backends/generation.js";

/** Descripteurs listTools et adaptateur callTool ; enregistrement explicite requis
 * in the host server. No Studio, database or remote generation access by default.
 */
export const generateTools = [
  { name: "generate_shot", description: "Prepare an existing local rush (the default, no key), or explicitly call Azure Sora.", inputSchema: {
    type: "object", properties: {
      backend: { type: "string", enum: ["local", "azure-sora"], default: "local" },
      source: { type: "string", description: "Local footage relative to ATELIER_WORK_DIR." },
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
      destination: { type: "string", description: "Relative path ; no existing file is overwritten." },
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
/** Offline example, with a source clip already available:
 * generate_shot {"source":"rushes/plan.mp4"}
 * generate_status {"id":"<returned id>"}
 * generate_fetch {"id":"<returned id>","destination":"assets/plan.mp4"}
 */
export async function callGenerateTool(name: string, args: unknown) {
  try {
    if (!generateTools.some(tool => tool.name === name)) throw new Error("Unknown generation tool.");
    const input = object(args);
    const allowed = name === "generate_shot" ? ["backend", "source", "prompt", "seconds", "size"] : name === "generate_status" ? ["backend", "id"] : ["backend", "id", "destination"];
    if (Object.keys(input).some(key => !allowed.includes(key))) throw new Error("Unknown parameter for this tool.");
    const backend = await createGenerationBackend(backendName(input.backend), name === "generate_shot" ? undefined : text(input.id, "id"));
    let result: unknown;
    switch (name) {
      case "generate_shot": {
        const request: VideoGenerationRequest = {};
        if (input.source !== undefined) request.source = text(input.source, "source");
        if (input.prompt !== undefined) request.prompt = text(input.prompt, "prompt");
        if (input.seconds !== undefined) {
          if (input.seconds !== "4" && input.seconds !== "8" && input.seconds !== "12") throw new Error("seconds : expected string 4, 8 or 12.");
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
    // Native fs/fetch errors may contain a private path or endpoint.
    const native = error instanceof Error && ("code" in error || error instanceof TypeError || error.name === "TimeoutError" || error.name === "AbortError");
    const message = native ? "Generation : unable to access file or network. Check relative paths, permissions and connector configuration." : error instanceof Error ? error.message : "Generation failed.";
    return { isError: true, content: [{ type: "text" as const, text: message }] };
  }
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/** Same server.tool API as src/tools/media.ts ; call at stdio startup. */
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
