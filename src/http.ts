import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { atomicJson, idSchema, initWork, mediaPath, readJson, workDir } from './tools/media.js';
import { compositionSchema, loadComp, mutateComp, type Composition } from './tools/timeline.js';
import { versEditeur, depuisEditeur } from './comp-forme.js';

// Same path from src/http.ts and dist/http.js. No implicit cwd.
const webRoot = fileURLToPath(new URL('../web-dist/', import.meta.url));
const buildHelp = 'UI missing : build the UI in web-dist/, or use the Docker image that contains it. The server remains accessible only on 127.0.0.1 (also inside the container).';
const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.map': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.flac': 'audio/flac', '.aac': 'audio/aac', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8', '.vtt': 'text/vtt; charset=utf-8'
};
class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
function code(error: unknown): string | undefined { return (error as NodeJS.ErrnoException | null)?.code; }
function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
}
function publicError(res: ServerResponse, error: unknown): void {
  if (res.destroyed) return;
  if (res.headersSent) { res.destroy(); return; }
  if (error instanceof HttpError) { json(res, error.status, { error: error.message }); return; }
  if (code(error) === 'ENOENT' || code(error) === 'ENOTDIR') { json(res, 404, { error: 'Ressource introuvable.' }); return; }
  json(res, 500, { error: 'Could not handle the request.' });
}
async function body(req: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Corps application/json requis.');
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw new HttpError(415, 'Compressed request bodies are not supported.');
  const limit = 2 * 1024 * 1024;
  if (Number(req.headers['content-length']) > limit) throw new HttpError(413, 'Request body is capped at 2 MiB.');
  // Listeners rather than an iterator that destroys the socket before the 413 response.
  return new Promise((resolve, reject) => {
    let size = 0; let failed = false; const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) { failed = true; chunks.length = 0; reject(new HttpError(413, 'Request body is capped at 2 MiB.')); }
      else chunks.push(chunk);
    });
    req.once('end', () => {
      if (failed) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'Invalid JSON.')); }
    });
    req.once('error', reject);
    req.once('aborted', () => reject(new HttpError(400, 'Request aborted.')));
  });
}
const versionSchema = z.object({ ts: z.string(), label: z.string(), comp: compositionSchema });
type Version = z.infer<typeof versionSchema>;
function historyFile(id: string): string { return path.join(workDir, 'compositions', `${idSchema.parse(id)}.versions.json`); }
async function versions(id: string): Promise<Version[]> {
  try { return z.array(versionSchema).parse(await readJson(historyFile(id))); }
  catch (error) { if (code(error) === 'ENOENT') return []; throw error; }
}
async function archive(comp: Composition, label: string, history?: Version[]): Promise<void> {
  const all = history ?? await versions(comp.id);
  all.push({ ts: new Date().toISOString(), label, comp: structuredClone(comp) });
  await atomicJson(historyFile(comp.id), all);
}
// The editor preview shows ONE video. The edit can have multiple clips: we use the
// latest completed render if available, otherwise the first clip. Without a render, the preview thus shows the
// first shot only — this is a known limitation, not a converter defect.
async function apercu(comp: Composition): Promise<string> {
  try {
    const jobs = await readdir(path.join(workDir, 'renders'));
    const termines: Array<{ id: string; updated_at: string }> = [];
    for (const f of jobs.filter(n => n.endsWith('.json'))) {
      try {
        const job = await readJson<{ id: string; comp_id: string; state: string; output?: string; updated_at: string }>(path.join(workDir, 'renders', f));
        if (job.comp_id === comp.id && job.state === 'completed' && job.output) termines.push({ id: job.id, updated_at: job.updated_at });
      } catch { /* an unreadable job does not prevent reading others */ }
    }
    termines.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    if (termines[0]) return `/media/${termines[0].id}`;
  } catch { /* pas encore de dossier renders */ }
  const premier = comp.clips[0];
  return premier ? `/media/${premier.media_id}` : '';
}
async function editorResult(comp: Composition) { return { id: comp.id, output_assets: versEditeur(comp, await apercu(comp)) }; }
function validId(value: string): string {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) throw new HttpError(404, 'Ressource introuvable.');
  return parsed.data;
}
async function staticFile(urlPath: string): Promise<string> {
  const root = await realpath(webRoot);
  async function confined(relative: string): Promise<string> {
    const candidate = path.resolve(root, relative);
    const rel = path.relative(root, candidate);
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new HttpError(404, 'Ressource introuvable.');
    const actual = await realpath(candidate);
    const actualRel = path.relative(root, actual);
    if (actualRel === '..' || actualRel.startsWith(`..${path.sep}`) || path.isAbsolute(actualRel)) throw new HttpError(404, 'Ressource introuvable.');
    if (!(await stat(actual)).isFile()) throw new HttpError(404, 'Ressource introuvable.');
    return actual;
  }
  try { return await confined(urlPath.replace(/^\/+/, '') || 'index.html'); }
  catch (error) {
    if (code(error) !== 'ENOENT' && code(error) !== 'ENOTDIR' && !(error instanceof HttpError && error.status === 404)) throw error;
    return confined('index.html');
  }
}
async function sendFile(req: IncomingMessage, res: ServerResponse, file: string, ranged: boolean): Promise<void> {
  const handle = await open(file, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new HttpError(404, 'Ressource introuvable.');
    const size = info.size;
    let start = 0; let end = size - 1; let partial = false;
    // If-Range not validated : full response, as required by HTTP.
    if (ranged && req.method === 'GET' && req.headers.range && !req.headers['if-range']) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      let valid = !!match && !!(match[1] || match[2]) && size > 0;
      if (match && valid) {
        if (!match[1]) {
          const suffix = Number(match[2]); valid = Number.isSafeInteger(suffix) && suffix > 0;
          start = Math.max(0, size - suffix);
        } else {
          start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1;
          valid = Number.isSafeInteger(start) && Number.isSafeInteger(end) && start < size && start <= end;
          end = Math.min(end, size - 1);
        }
      }
      if (!valid) {
        res.setHeader('Content-Range', `bytes */${size}`);
        res.setHeader('Accept-Ranges', 'bytes');
        json(res, 416, { error: 'Invalid range: only a single byte range is supported.' }); return;
      }
      partial = true;
    }
    res.setHeader('Content-Type', mime[path.extname(file).toLowerCase()] || 'application/octet-stream');
    res.setHeader('Content-Length', Math.max(0, end - start + 1));
    res.setHeader('Cache-Control', 'no-cache');
    if (ranged) res.setHeader('Accept-Ranges', 'bytes');
    if (partial) res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    res.statusCode = partial ? 206 : 200;
    if (req.method === 'HEAD' || size === 0) { res.end(); return; }
    await pipeline(handle.createReadStream({ start, end, autoClose: false }), res);
  } finally { await handle.close(); }
}
async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  const host = `127.0.0.1:${req.socket.localPort}`;
  if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== `http://${host}`) || req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Local same-origin access required.');
  if (!req.url?.startsWith('/') || req.url.startsWith('//')) throw new HttpError(400, 'Invalid URL.');
  let pathname: string;
  try { pathname = decodeURIComponent(new URL(req.url, `http://${host}`).pathname); }
  catch { throw new HttpError(400, 'Invalid URL.'); }
  if (pathname.includes('\0') || pathname.includes('\\')) throw new HttpError(400, 'Invalid URL.');
  const method = req.method;
  if ((pathname === '/api/sam2/screen-replace' && method === 'POST') || (pathname === '/api/sam2/progress' && method === 'GET')) {
    json(res, 501, { error: 'This HTTP gateway does not provide SAM2. Enable the sam2 profile and use the SAM2 MCP tools ; no fallback or simulated tracking.' }); return;
  }
  if (pathname === '/api/comps' && method === 'GET') {
    const names = await readdir(path.join(workDir, 'compositions'));
    const list: Array<Pick<Composition, 'id' | 'name' | 'width' | 'height' | 'fps' | 'updated_at'>> = [];
    for (const name of names.sort()) {
      if (!name.endsWith('.json') || !idSchema.safeParse(name.slice(0, -5)).success) continue;
      const { id, name: title, width, height, fps, updated_at } = await loadComp(name.slice(0, -5));
      list.push({ id, name: title, width, height, fps, updated_at });
    }
    json(res, 200, list); return;
  }
  const compRoute = /^\/api\/comps\/([^/]+)(\/versions)?$/.exec(pathname);
  if (compRoute) {
    const id = validId(compRoute[1]!);
    if (!compRoute[2] && method === 'GET') { json(res, 200, await editorResult(await loadComp(id))); return; }
    if (!compRoute[2] && method === 'PATCH') {
      const parsed = z.object({ output_assets: z.record(z.unknown()) }).strict().safeParse(await body(req));
      if (!parsed.success) throw new HttpError(400, 'Expected body: { output_assets: object }.');
      const comp = await mutateComp(id, async current => {
        // The converter does not receive the original to archive and must reject data it cannot represent.
        let converted: Composition;
        try {
          converted = compositionSchema.parse(await depuisEditeur(parsed.data.output_assets as unknown as Parameters<typeof depuisEditeur>[0], structuredClone(current)));
        } catch { throw new HttpError(422, 'Invalid editor data, or a shape this converter does not support.'); }
        converted.id = current.id; converted.created_at = current.created_at;
        await archive(current, 'before-patch');
        Object.assign(current, converted);
      }); // mutateComp calls saveComp under the shared MCP/HTTP lock.
      json(res, 200, await editorResult(comp)); return;
    }
    if (compRoute[2] && method === 'GET') {
      await loadComp(id);
      json(res, 200, (await versions(id)).map(({ ts, label }) => ({ ts, label }))); return;
    }
    if (compRoute[2] && method === 'POST') {
      const parsed = z.object({ idx: z.number().int().nonnegative().safe() }).strict().safeParse(await body(req));
      if (!parsed.success) throw new HttpError(400, 'Expected body: { idx: non-negative integer }.');
      const comp = await mutateComp(id, async current => {
        const all = await versions(id); const selected = all[parsed.data.idx];
        if (!selected) throw new HttpError(404, 'Version introuvable.');
        const restored = structuredClone(selected.comp);
        restored.id = current.id; restored.created_at = current.created_at;
        await archive(current, `restore-from-${parsed.data.idx}`, all);
        Object.assign(current, restored);
      });
      json(res, 200, await editorResult(comp)); return;
    }
  }
  const media = /^\/media\/([^/]+)$/.exec(pathname);
  if (media && (method === 'GET' || method === 'HEAD')) {
    await sendFile(req, res, await mediaPath(validId(media[1]!)), true); return;
  }
  if (pathname === '/api' || pathname.startsWith('/api/') || pathname === '/media' || pathname.startsWith('/media/') || method !== 'GET') throw new HttpError(404, 'Route introuvable.');
  await sendFile(req, res, await staticFile(pathname), false);
}

let active: Server | undefined;
let activeUrl: string | undefined;
let lifecycle: Promise<unknown> = Promise.resolve();
function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const pending = lifecycle.catch(() => undefined).then(operation);
  lifecycle = pending; return pending;
}
function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const failed = (error: Error): void => { server.off('listening', ready); reject(error); };
    const ready = (): void => { server.off('error', failed); resolve(); };
    server.once('error', failed); server.once('listening', ready);
    server.listen(port, '127.0.0.1');
  });
}
export function startUi(port = 4321): Promise<{ url: string; interface_ready: boolean; message: string }> {
  return serialized(async () => {
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port invalide.');
    let ready = false;
    try { ready = (await stat(path.join(webRoot, 'index.html'))).isFile(); }
    catch (error) { if (code(error) !== 'ENOENT' && code(error) !== 'ENOTDIR') throw error; }
    if (!active) {
      await initWork();
      const server = createServer((req, res) => { void route(req, res).catch(error => publicError(res, error)); });
      server.requestTimeout = 30000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000;
      server.maxHeadersCount = 100;
      try { await listen(server, port); }
      catch (error) { if (code(error) !== 'EADDRINUSE' || port === 0) throw error; await listen(server, 0); }
      const address = server.address();
      if (!address || typeof address === 'string') { server.close(); throw new Error('Adresse HTTP indisponible.'); }
      active = server; activeUrl = `http://127.0.0.1:${address.port}`;
    }
    return { url: activeUrl!, interface_ready: ready, message: ready ? 'Open this URL on the machine running the MCP server.' : buildHelp };
  });
}
export function stopUi(): Promise<void> {
  return serialized(async () => {
    const server = active;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    active = undefined; activeUrl = undefined;
  });
}
