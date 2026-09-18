import { z } from 'zod';
import { tool, type ToolServer } from './media.js';
import { startUi, stopUi } from '../http.js';

export function registerUi(server: ToolServer): void {
  tool(server, 'ui_start', 'Démarrer l’éditeur local sur 127.0.0.1 ; construire web-dist ou utiliser l’image Docker contenant l’interface si elle est absente.', {
    port: z.number().int().min(0).max(65535).default(4321)
  }, async ({ port }) => startUi(port));
  tool(server, 'ui_stop', 'Arrêter le serveur HTTP de l’éditeur local.', {}, async () => {
    await stopUi(); return { stopped: true };
  });
  // Fermer aussi les flux vidéo actifs sans modifier le cycle d’arrêt MCP existant.
  const close = (): void => { void stopUi().catch(() => { process.exitCode = 1; }); };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  process.stdin.once('end', close);
}
