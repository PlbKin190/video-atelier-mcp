import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { randomUUID } from 'node:crypto';
import { writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { registerMedia, tool, initWork, workDir, ffmpeg, ffprobe, run, mediaPath } from './tools/media.js';
import { registerTimeline } from './tools/timeline.js';
import { registerCut } from './tools/cut.js';
import { registerCaptions } from './tools/captions.js';
import { registerAudio } from './tools/audio.js';
import { registerRender, recoverRenders, stopRenders } from './tools/render.js';
import { registerGenerate } from './tools/generate.js';
import { registerSam2 } from './tools/sam2.js';
import { registerExport } from './tools/export.js';

// Contrat substituable de résolution des rushes existants.
export interface GenerationConnector {
  readonly id: string;
  readonly configured: boolean;
  resolve(request: { media_id: string }): Promise<{ path: string }>;
}
export const localConnector: GenerationConnector = {
  id: 'local', configured: true,
  async resolve({ media_id }) { return { path: await mediaPath(media_id) }; }
};
// Dates issues du cahier des charges, non vérifiées par une source réseau.
// Présence de configuration ne signifie pas disponibilité distante.
function connectorStatus() {
  return [
    { id: localConnector.id, configured: localConnector.configured, mode: 'existing_media' },
    { id: 'azure-sora', registered: true, configured: Boolean(process.env.AZURE_SORA_ENDPOINT && process.env.AZURE_SORA_API_KEY), availability: 'not_checked', lifecycle: 'end_of_life', api_retirement: '2026-09-24', azure_version_retirement: '2026-10-15', reason: 'Connecteur de compatibilité enregistré ; accès distant vérifié uniquement à la demande' }
  ];
}
const server = new McpServer({ name: 'video-atelier-mcp', version: '0.1.0' });
registerMedia(server);
registerTimeline(server);
registerCut(server);
registerCaptions(server);
registerAudio(server);
registerRender(server);
registerExport(server);
registerGenerate(server);
registerSam2(server);
tool(server, 'health_check', 'Check binaries, codecs, filters and local write access; report which backends are configured.', {}, async () => {
  const checks: Record<string, { ok: boolean; detail: string }> = {};
  for (const [name, binary] of [['ffmpeg', ffmpeg], ['ffprobe', ffprobe]] as const) {
    try { checks[name] = { ok: true, detail: (await run(binary, ['-version'])).split('\n')[0] || binary }; }
    catch (error) { checks[name] = { ok: false, detail: String(error) }; }
  }
  try {
    const encoders = await run(ffmpeg, ['-hide_banner', '-encoders']);
    checks['render_codecs'] = { ok: /\blibx264\b/.test(encoders) && /\baac\b/.test(encoders), detail: 'Requis: libx264, aac' };
    const filters = await run(ffmpeg, ['-hide_banner', '-filters']);
    checks['captions_burn'] = { ok: /\bsubtitles\b/.test(filters), detail: 'Filtre subtitles/libass requis; polices à installer dans l’image' };
  } catch (error) { checks['ffmpeg_capabilities'] = { ok: false, detail: String(error) }; }
  const testFile = path.join(workDir, 'tmp', `health-${randomUUID()}`);
  try { await writeFile(testFile, 'ok', { flag: 'wx' }); await unlink(testFile); checks['work_dir'] = { ok: true, detail: workDir }; }
  catch (error) { checks['work_dir'] = { ok: false, detail: String(error) }; }
  return { ok: Object.values(checks).every(check => check.ok), checks, connectors: connectorStatus(), registered_modules: ['media', 'timeline', 'cut', 'captions', 'audio', 'render', 'export', 'generate', 'sam2'], optional: { whisper: 'CLI externe, vérifiée à la demande', generate: '3 outils enregistrés ; local sans clé, Azure optionnel en fin de vie', sam2: '7 outils enregistrés ; Python, dépendances et modèles vérifiés à la demande, hors image de base' }, tools: 44 };
});
let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return; shuttingDown = true;
  await stopRenders(); await server.close();
}
process.once('SIGTERM', () => { void shutdown().catch(console.error); });
process.once('SIGINT', () => { void shutdown().catch(console.error); });
process.stdin.once('end', () => { void shutdown().catch(console.error); });
async function main(): Promise<void> {
  await initWork();
  await recoverRenders();
  await server.connect(new StdioServerTransport());
}
void main().catch(error => { console.error('Démarrage impossible:', error); process.exitCode = 1; void shutdown().catch(console.error); });
