import { z } from 'zod';
import { tool, type ToolServer } from './media.js';
import { startUi, stopUi } from '../http.js';

export function registerUi(server: ToolServer): void {
  tool(server, 'ui_start', 'Start the local editor on 127.0.0.1. If web-dist is missing, build it or use the Docker image, which ships it.', {
    port: z.number().int().min(0).max(65535).default(4321)
  }, async ({ port }) => startUi(port));
  tool(server, 'ui_stop', 'Stop the local editor\'s HTTP server.', {}, async () => {
    await stopUi(); return { stopped: true };
  });
  // Also close active video streams without changing the existing MCP shutdown lifecycle.
  const close = (): void => { void stopUi().catch(() => { process.exitCode = 1; }); };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  process.stdin.once('end', close);
}
