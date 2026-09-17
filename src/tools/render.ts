import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, rename, stat, unlink } from 'node:fs/promises';
import { z } from 'zod';
import { tool, workDir, ffmpeg, run, probe, mediaPath, atomicJson, readJson, recordPath, idSchema, localFile, type ToolServer } from './media.js';
import { loadComp, validateComp, totalDuration, compositionSchema, type Composition } from './timeline.js';
import { videoEncoding } from './cut.js';
import { mixGraph, type MixInput } from './audio.js';

type State = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
interface Job { id: string; comp_id: string; composition: Composition; state: State; created_at: string; updated_at: string; attempts: number; output?: string; error?: string }
const controllers = new Map<string, AbortController>();
const queue: string[] = [];
let busy = false; let stopping = false;
async function loadJob(id: string): Promise<Job> { return readJson<Job>(recordPath('renders', id)); }
async function saveJob(job: Job): Promise<void> { job.updated_at = new Date().toISOString(); await atomicJson(recordPath('renders', job.id), job); }
async function command(args: string[], signal: AbortSignal): Promise<void> { await run(ffmpeg, ['-nostdin', '-hide_banner', '-y', ...args], signal); }
async function render(job: Job, signal: AbortSignal): Promise<string> {
  const comp = compositionSchema.parse(job.composition); const validation = await validateComp(comp);
  if (!validation.valid) throw new Error(validation.errors.join('\n'));
  const directory = path.join(workDir, 'renders', job.id); await mkdir(directory, { recursive: true });
  const files: string[] = []; const duration = totalDuration(comp);
  try {
    for (const [index, clip] of comp.clips.entries()) {
      const source = await mediaPath(clip.media_id); const info = await probe(source);
      const audio = info.streams.some(stream => stream.codec_type === 'audio');
      const filters = [`scale=${comp.width}:${comp.height}:force_original_aspect_ratio=decrease`, `pad=${comp.width}:${comp.height}:(ow-iw)/2:(oh-ih)/2`, 'setsar=1', `fps=${comp.fps}`, 'format=yuv420p', 'setpts=PTS-STARTPTS'];
      const previous = comp.clips[index - 1];
      const incoming = previous ? comp.transitions.find(t => t.after_clip_id === previous.id) : undefined;
      const outgoing = comp.transitions.find(t => t.after_clip_id === clip.id);
      if (incoming) filters.push(`fade=t=in:st=0:d=${incoming.duration}`);
      if (outgoing) filters.push(`fade=t=out:st=${clip.duration - outgoing.duration}:d=${outgoing.duration}`);
      const segment = path.join(directory, `segment-${index}.mp4`);
      await command(['-ss', String(clip.in), '-i', source, ...(!audio ? ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo'] : []), '-t', String(clip.duration), '-map', '0:v:0', '-map', audio ? '0:a:0' : '1:a:0', '-vf', filters.join(','), '-af', 'asetpts=PTS-STARTPTS,aresample=48000,apad', ...videoEncoding, '-c:a', 'aac', '-ar', '48000', '-ac', '2', segment], signal);
      files.push(segment);
    }
    const base = path.join(directory, 'base.mp4');
    const concat = files.map((_, i) => `[${i}:v:0]setpts=PTS-STARTPTS[v${i}];[${i}:a:0]asetpts=PTS-STARTPTS[a${i}]`).join(';') + ';' + files.map((_, i) => `[v${i}][a${i}]`).join('') + `concat=n=${files.length}:v=1:a=1[v][a]`;
    await command([...files.flatMap(file => ['-i', file]), '-filter_complex', concat, '-map', '[v]', '-map', '[a]', ...videoEncoding, '-c:a', 'aac', '-t', String(duration), base], signal);
    let visual = base;
    for (const [i, overlay] of comp.overlays.entries()) {
      const next = path.join(directory, `overlay-${i}.mp4`);
      const graph = `[1:v:0]scale=${overlay.width}:${overlay.height},setsar=1,setpts=PTS-STARTPTS+${overlay.start}/TB[ov];[0:v:0][ov]overlay=x=${overlay.x}:y=${overlay.y}:enable='between(t,${overlay.start},${overlay.start + overlay.duration})':eof_action=repeat[v]`;
      await command(['-i', visual, '-i', await mediaPath(overlay.media_id), '-filter_complex', graph, '-map', '[v]', '-map', '0:a:0', ...videoEncoding, '-c:a', 'copy', '-t', String(duration), next], signal); visual = next;
    }
    const tracks: MixInput[] = [{ path: visual, volume: comp.audio.original_volume, start: 0, trim_start: 0 }];
    for (const track of comp.audio.tracks) tracks.push({ ...track, path: await mediaPath(track.media_id) });
    const partial = path.join(directory, 'final.mp4');
    await command([...tracks.flatMap(track => ['-i', track.path]), '-filter_complex', mixGraph(tracks, duration), '-map', '0:v:0', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-t', String(duration), '-movflags', '+faststart', partial], signal);
    if (signal.aborted) throw new Error('Rendu annulé');
    const output = path.join(workDir, 'outputs', `${job.id}.mp4`); await rename(partial, output); return output;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
async function pump(): Promise<void> {
  if (busy || stopping) return; busy = true;
  try {
    while (queue.length && !stopping) {
      const id = queue.shift()!; const job = await loadJob(id);
      if (job.state !== 'queued') continue;
      const controller = new AbortController(); controllers.set(id, controller);
      try {
        job.state = 'running'; job.attempts++; await saveJob(job);
        const output = await render(job, controller.signal);
        if (controller.signal.aborted) { await unlink(output).catch(() => undefined); throw new Error('Rendu annulé'); }
        job.output = output; job.state = 'completed'; delete job.error;
      } catch (error) {
        job.state = controller.signal.aborted ? (stopping ? 'queued' : 'cancelled') : 'failed';
        job.error = error instanceof Error ? error.message : String(error);
      }
      await saveJob(job); controllers.delete(id);
    }
  } finally { busy = false; }
}
function schedule(): void { void pump().catch(error => { console.error('File de rendus:', error); }); }
export async function recoverRenders(): Promise<void> {
  // Un seul processus serveur par workDir. Pas de verrou inter-processus.
  for (const file of (await readdir(path.join(workDir, 'renders'))).filter(file => file.endsWith('.json')).sort()) {
    try {
      const job = await loadJob(file.slice(0, -5));
      if (job.state === 'running' || job.state === 'queued') {
        // Publication atomique avant écriture du statut: reconnaître un rendu déjà terminé.
        const output = path.join(workDir, 'outputs', `${job.id}.mp4`);
        if ((await stat(output).catch(() => null))?.isFile()) { job.state = 'completed'; job.output = output; delete job.error; }
        else { job.state = 'queued'; queue.push(job.id); }
        await saveJob(job);
      }
    } catch (error) { console.error(`Job ignoré ${file}:`, error); }
  }
  schedule();
}
export async function stopRenders(): Promise<void> {
  stopping = true; for (const controller of controllers.values()) controller.abort();
  while (busy) await new Promise(resolve => setTimeout(resolve, 50));
}
export function registerRender(server: ToolServer): void {
  tool(server, 'render_start', 'Start an asynchronous local render. The job is a durable JSON snapshot; an interrupted render restarts from the beginning.', { comp_id: idSchema }, async ({ comp_id }) => {
    if (stopping) throw new Error('Serveur en arrêt');
    const composition = await loadComp(comp_id); const validation = await validateComp(composition);
    if (!validation.valid) throw new Error(validation.errors.join('\n'));
    const now = new Date().toISOString(); const job: Job = { id: randomUUID(), comp_id, composition, state: 'queued', attempts: 0, created_at: now, updated_at: now };
    await saveJob(job); queue.push(job.id); schedule(); return { job_id: job.id, state: 'queued' };
  });
  tool(server, 'render_status', 'Persisted render state (no estimated percentage).', { job_id: idSchema }, async ({ job_id }) => { const { composition: _snapshot, ...job } = await loadJob(job_id); return job; });
  tool(server, 'render_get_output', 'Return the path of the finished MP4.', { job_id: idSchema }, async ({ job_id }) => { const job = await loadJob(job_id); if (job.state !== 'completed' || !job.output) throw new Error(`Rendu non disponible: ${job.state}`); return { job_id, path: await localFile(job.output) }; });
  tool(server, 'render_cancel', 'Cancel a queued job, or kill its running ffmpeg.', { job_id: idSchema }, async ({ job_id }) => {
    const controller = controllers.get(job_id);
    if (controller) { controller.abort(); return { job_id, cancellation_requested: true }; }
    const job = await loadJob(job_id);
    // Recontrôle après lecture asynchrone: le worker peut avoir pris le job.
    const active = controllers.get(job_id);
    if (active) { active.abort(); return { job_id, cancellation_requested: true }; }
    if (job.state === 'queued') { const index = queue.indexOf(job_id); if (index >= 0) queue.splice(index, 1); job.state = 'cancelled'; await saveJob(job); }
    return { job_id, state: job.state };
  });
  tool(server, 'render_history', 'Durable render history, most recent first.', { limit: z.number().int().min(1).max(1000).default(50) }, async ({ limit }) => {
    const jobs = await Promise.all((await readdir(path.join(workDir, 'renders'))).filter(file => file.endsWith('.json')).map(file => loadJob(file.slice(0, -5))));
    return jobs.sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit).map(({ composition: _snapshot, ...job }) => job);
  });
}
