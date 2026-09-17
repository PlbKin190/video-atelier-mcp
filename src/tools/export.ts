import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { tool, localFile, probe, encode, thumbnail, outputPath, type ToolServer } from './media.js';
import { videoEncoding } from './cut.js';

const formats = { '16:9': { width: 1920, height: 1080 }, '9:16': { width: 1080, height: 1920 }, '1:1': { width: 1080, height: 1080 } } as const;
export function registerExport(server: ToolServer): void {
  tool(server, 'export_formats', 'List the aspect ratios; with an input, export it with a centred cover crop.', { input: z.string().optional(), format: z.enum(['16:9', '9:16', '1:1']).optional() }, async ({ input, format }) => {
    if (!input) return { formats, mode: 'center_crop' };
    if (!format) throw new Error('Choisir format avec input');
    const { width, height } = formats[format];
    return { ...(await encode(['-i', await localFile(input), '-map', '0:v:0', '-map', '0:a:0?', '-vf', `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1`, ...videoEncoding, '-c:a', 'aac', '-movflags', '+faststart'])), format, width, height };
  });
  tool(server, 'export_gif', 'Export a GIF excerpt with an optimised palette (30 seconds max).', { input: z.string(), start: z.number().finite().nonnegative().default(0), duration: z.number().finite().positive().max(30).default(5), width: z.number().int().min(2).max(1920).default(480), fps: z.number().int().min(1).max(30).default(12) }, async ({ input, start, duration, width, fps }) => encode(['-ss', String(start), '-t', String(duration), '-i', await localFile(input), '-filter_complex', `[0:v:0]fps=${fps},scale=${width}:-2:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse[v]`, '-map', '[v]', '-an', '-loop', '0'], 'gif'));
  tool(server, 'export_thumbnail_set', 'Extract a set of thumbnails, one at the centre of each interval.', { input: z.string(), count: z.number().int().min(1).max(100).default(5), width: z.number().int().min(2).max(4096).default(640) }, async ({ input, count, width }) => {
    const file = await localFile(input); const info = await probe(file); const duration = Number(info.format?.duration);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('Durée vidéo inconnue');
    const thumbnails: Array<{ time: number; path: string }> = [];
    for (let i = 0; i < count; i++) { const time = duration * (i + 0.5) / count; thumbnails.push({ time, ...(await thumbnail(file, time, width)) }); }
    return { thumbnails };
  });
  tool(server, 'export_meta', 'Write the ffprobe metadata to a local JSON file.', { input: z.string() }, async ({ input }) => {
    const source = await localFile(input); const metadata = await probe(source); const file = outputPath('json');
    await writeFile(file, JSON.stringify({ source, exported_at: new Date().toISOString(), metadata }, null, 2)); return { path: file, metadata };
  });
}
