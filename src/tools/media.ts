import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, rename, readdir, copyFile, realpath, stat, lstat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

// Infrastructure commune aux outils et backends.
export const workDir = path.resolve(process.env.ATELIER_WORK_DIR || '/work');
export const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
export const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
export const idSchema = z.string().uuid();
export const positive = z.number().finite().positive();
export const nonnegative = z.number().finite().nonnegative();
export type ToolServer = McpServer;
// Élargir uniquement la frontière SDK : le schéma effectif reste celui de T.
// Les arguments du rappel sont validés par ce schéma avant leur transmission.
export function tool<T extends z.ZodRawShape>(server: ToolServer, name: string, description: string, shape: T, fn: (args: z.infer<z.ZodObject<T>>) => Promise<unknown>): void {
  const inputSchema: z.ZodRawShape = shape;
  server.registerTool(name, { description, inputSchema }, async args => {
    try { return { content: [{ type: 'text' as const, text: JSON.stringify(await fn(args as z.infer<z.ZodObject<T>>)) }] }; }
    catch (error) { return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }] }; }
  });
}
export async function initWork(): Promise<void> {
  await mkdir(workDir, { recursive: true });
  const root = await realpath(workDir);
  for (const dir of ['media', 'outputs', 'compositions', 'renders', 'tmp']) {
    const target = path.join(workDir, dir); await mkdir(target, { recursive: true });
    if (await realpath(target) !== path.join(root, dir)) throw new Error(`Dossier symbolique interdit: ${dir}`);
  }
}
export async function atomicJson(file: string, value: unknown): Promise<void> {
  const temp = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temp, JSON.stringify(value, null, 2), { flag: 'wx' }); await rename(temp, file); }
  finally { await unlink(temp).catch(() => undefined); }
}
export async function readJson<T>(file: string): Promise<T> { return JSON.parse(await readFile(await localFile(file), 'utf8')) as T; }
export function recordPath(folder: string, id: string): string { return path.join(workDir, folder, `${idSchema.parse(id)}.json`); }
async function cheminValide(input: string): Promise<string> {
  const root = await realpath(workDir); const resolved = await realpath(path.resolve(workDir, input));
  if (!resolved.startsWith(`${root}${path.sep}`) || !(await stat(resolved)).isFile()) throw new Error('Fichier requis à l’intérieur de ATELIER_WORK_DIR. Utiliser media_import.');
  return resolved;
}
// Résout indifféremment un identifiant média ou un chemin sous workDir.
export async function localFile(input: string): Promise<string> {
  if (idSchema.safeParse(input).success) {
    try { return await cheminValide((await readJson<MediaRecord>(recordPath('media', input))).path); }
    catch { /* identifiant inconnu du magasin : on le retente comme chemin */ }
  }
  return cheminValide(input);
}
/** Destination nouvelle relative ; parents réels confinés, écrasement interdit.
 * Port du contrôle de generation. Ouverture exclusive requise par l'appelant.
 * Le dossier doit rester privé : pas de protection contre les courses TOCTOU.
 */
export async function newWorkFile(relative: string): Promise<string> {
  if (!relative || path.isAbsolute(relative) || relative.includes('\0')) throw new Error('Chemin relatif au dossier de travail attendu.');
  await mkdir(workDir, { recursive: true });
  const root = await realpath(workDir);
  const within = (file: string): void => {
    const rel = path.relative(root, file);
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error('Chemin hors du dossier de travail interdit.');
  };
  const target = path.resolve(root, relative);
  within(target);
  if (target === root) throw new Error('Un fichier, pas la racine, est attendu.');
  const parts = path.relative(root, path.dirname(target)).split(path.sep).filter(Boolean);
  let parent = root;
  for (const part of parts) {
    parent = path.join(parent, part);
    try { await mkdir(parent); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    parent = await realpath(parent);
    within(parent);
    if (!(await stat(parent)).isDirectory()) throw new Error('Parent non répertoire.');
  }
  const result = path.join(parent, path.basename(target));
  try { await lstat(result); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result;
    throw error;
  }
  throw new Error('Destination existante : écrasement interdit.');
}
export function outputPath(extension: string): string { return path.join(workDir, 'outputs', `${randomUUID()}.${extension}`); }
export async function run(binary: string, args: string[], signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new Error('Opération annulée');
  return new Promise((resolve, reject) => {
    // Empêche les protocoles réseau indirects de playlists importées; pas une sandbox.
    const effective = binary === ffmpeg ? args.flatMap(arg => arg === '-i' ? ['-protocol_whitelist', 'file,pipe', arg] : [arg]) : binary === ffprobe && args.includes('-show_streams') ? ['-protocol_whitelist', 'file,pipe', ...args] : args;
    const child = spawn(binary, effective, { stdio: ['ignore', 'pipe', 'pipe'], cwd: workDir });
    let stdout = ''; let stderr = ''; let failure: Error | undefined;
    const abort = (error: Error): void => { failure ||= error; child.kill('SIGKILL'); };
    const onAbort = (): void => abort(new Error('Opération annulée'));
    signal?.addEventListener('abort', onAbort, { once: true }); if (signal?.aborted) onAbort();
    const timer = setTimeout(() => abort(new Error(`${binary}: délai maximal de 6 heures dépassé`)), 21600000); timer.unref();
    child.stdout.on('data', (chunk: Buffer) => { if (!failure) { stdout += chunk.toString(); if (Buffer.byteLength(stdout) > 16 * 1024 * 1024) abort(new Error('Sortie trop volumineuse')); } });
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-65536); });
    child.once('error', error => { failure = error; });
    // Attendre close avant nettoyage des fichiers même après annulation.
    child.once('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
      if (failure) reject(failure); else if (code !== 0) reject(new Error(`${binary}: code ${code}\n${stderr}`)); else resolve(stdout);
    });
  });
}
export interface Probe { format?: { duration?: string; format_name?: string }; streams: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number; duration?: string }> }
export async function probe(file: string): Promise<Probe> { return JSON.parse(await run(ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file])) as Probe; }
// Toute sortie est enregistrée comme un média de plein droit et rend son identifiant. Sans cela la
// chaîne casse : `comp_add_clip` exige un identifiant, alors que découpe, concaténation et
// sous-titres ne rendaient qu'un chemin — mesuré de bout en bout le 17/09/2026.
// Enregistre un fichier déjà écrit comme média de plein droit. Tout outil qui produit un fichier
// SANS passer par `encode` doit l'appeler : sinon il rend un chemin que `comp_add_clip`, qui exige
// un identifiant, ne peut pas recevoir — c'est le défaut qu'une revue a trouvé sur le rendu, les
// sous-titres et l'export des métadonnées, là où mon propre essai de bout en bout l'avait masqué.
export async function enregistrer(file: string, id: string = randomUUID()): Promise<{ id: string; path: string }> {
  const record: MediaRecord = { id, path: file, name: path.basename(file), created_at: new Date().toISOString() };
  await atomicJson(recordPath('media', id), record);
  return { id, path: file };
}
export async function encode(args: string[], extension = 'mp4'): Promise<{ id: string; path: string }> {
  const id = randomUUID();
  const file = path.join(workDir, 'outputs', `${id}.${extension}`);
  try {
    await run(ffmpeg, ['-nostdin', '-hide_banner', '-y', ...args, file]);
    return await enregistrer(file, id);
  } catch (error) { await unlink(file).catch(() => undefined); throw error; }
}
export interface MediaRecord { id: string; path: string; name: string; created_at: string }
export async function mediaPath(id: string): Promise<string> { return localFile((await readJson<MediaRecord>(recordPath('media', id))).path); }
export async function thumbnail(file: string, at: number, width: number): Promise<{ id: string; path: string }> { return encode(['-ss', String(at), '-i', file, '-frames:v', '1', '-vf', `scale=${width}:-2`], 'jpg'); }
export function registerMedia(server: ToolServer): void {
  tool(server, 'media_import', 'Copy a local file or an HTTP(S) URL into the local media store.', { source: z.string().min(1), name: z.string().max(240).optional() }, async ({ source, name }) => {
    const id = randomUUID(); const remote = /^https?:\/\//i.test(source);
    const basename = path.basename(remote ? new URL(source).pathname : source); const ext = path.extname(basename).toLowerCase();
    const file = path.join(workDir, 'media', `${id}${/^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '.bin'}`);
    try {
      if (remote) {
        // Agent de confiance: pas de filtrage SSRF des URL privées; ne pas exposer publiquement.
        const response = await fetch(source, { signal: AbortSignal.timeout(300000) });
        if (!response.ok || !response.body) throw new Error(`Téléchargement HTTP ${response.status}`);
        let bytes = 0;
        const limiter = new Transform({ transform(chunk: Buffer, _encoding, callback) { bytes += chunk.length; callback(bytes > 2 * 1024 ** 3 ? new Error('Import limité à 2 Gio') : null, chunk); } });
        await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>), limiter, createWriteStream(file, { flags: 'wx' }));
      } else {
        if (!(await stat(source)).isFile()) throw new Error('La source doit être un fichier'); await copyFile(source, file);
      }
      const record: MediaRecord = { id, path: file, name: name || basename || id, created_at: new Date().toISOString() };
      await atomicJson(recordPath('media', id), record); return record;
    } catch (error) { await unlink(file).catch(() => undefined); throw error; }
  });
  tool(server, 'media_list', 'List imported media.', {}, async () => {
    const files = (await readdir(path.join(workDir, 'media'))).filter(file => file.endsWith('.json'));
    return Promise.all(files.map(file => readJson<MediaRecord>(path.join(workDir, 'media', file))));
  });
  tool(server, 'media_probe', 'Probe a media file with ffprobe.', { media_id: idSchema }, async ({ media_id }) => probe(await mediaPath(media_id)));
  tool(server, 'media_extract_frames', 'Extract frames at a fixed interval (300 max).', { media_id: idSchema, start: nonnegative.default(0), interval: positive.default(1), count: z.number().int().min(1).max(300).default(10), width: z.number().int().min(2).max(4096).default(640) }, async ({ media_id, start, interval, count, width }) => {
    const file = await mediaPath(media_id); const frames: Array<{ id: string; path: string }> = [];
    // thumbnail() passe par encode(), donc chaque image EST déjà un média : on garde son identifiant
    // au lieu de ne rendre que le chemin, sinon l'agent ne peut plus rien en faire.
    for (let i = 0; i < count; i++) frames.push(await thumbnail(file, start + interval * i, width)); return { frames };
  });
  tool(server, 'media_thumbnail', 'Extract a single JPEG thumbnail.', { media_id: idSchema, at: nonnegative.default(0), width: z.number().int().min(2).max(4096).default(640) }, async ({ media_id, at, width }) => thumbnail(await mediaPath(media_id), at, width));
}
