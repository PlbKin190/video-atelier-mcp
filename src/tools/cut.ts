import { writeFile, unlink } from 'node:fs/promises';
import { z } from 'zod';
import { tool, localFile, encode, outputPath, positive, nonnegative, type ToolServer } from './media.js';

// Portage: video-studio-mcp/src/tools/ffmpeg-primitives.ts:55-77,107-127,205-230.
// No shell, libx264 software codec. Concatenation preserves the video-only contract.
export function atempo(speed: number): string {
  const factors: number[] = []; let rest = speed;
  while (rest > 2) { factors.push(2); rest /= 2; }
  while (rest < 0.5) { factors.push(0.5); rest /= 0.5; }
  factors.push(rest); return factors.map(value => `atempo=${value}`).join(',');
}
export const videoEncoding = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p'];
export function registerCut(server: ToolServer): void {
  tool(server, 'clip_trim', 'Trim with frame-accurate re-encoding (seconds).', { input: z.string(), start: nonnegative.default(0), duration: positive }, async ({ input, start, duration }) => encode(['-ss', String(start), '-i', await localFile(input), '-t', String(duration), '-map', '0:v:0', '-map', '0:a:0?', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', ...videoEncoding, '-c:a', 'aac', '-movflags', '+faststart']));
  tool(server, 'clip_concat', 'Concatenate videos (video only), normalised to a common size and frame rate.', { inputs: z.array(z.string()).min(1).max(100), width: z.number().int().min(2).max(7680).multipleOf(2).default(1920), height: z.number().int().min(2).max(7680).multipleOf(2).default(1080), fps: z.number().int().min(1).max(120).default(30) }, async ({ inputs, width, height, fps }) => {
    const args: string[] = []; const filters: string[] = [];
    for (const [i, input] of inputs.entries()) {
      args.push('-i', await localFile(input));
      filters.push(`[${i}:v:0]setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p[v${i}]`);
    }
    filters.push(`${inputs.map((_, i) => `[v${i}]`).join('')}concat=n=${inputs.length}:v=1:a=0[v]`);
    return encode([...args, '-filter_complex', filters.join(';'), '-map', '[v]', '-an', ...videoEncoding, '-movflags', '+faststart']);
  });
  tool(server, 'clip_speed', 'Change video and audio speed, from 0.0625x to 16x.', { input: z.string(), speed: z.number().finite().min(0.0625).max(16) }, async ({ input, speed }) => encode(['-i', await localFile(input), '-map', '0:v:0', '-map', '0:a:0?', '-vf', `setpts=(PTS-STARTPTS)/${speed},scale=trunc(iw/2)*2:trunc(ih/2)*2`, '-af', atempo(speed), ...videoEncoding, '-c:a', 'aac', '-movflags', '+faststart']));
  tool(server, 'clip_crop', 'Crop to the given rectangle, without scaling.', { input: z.string(), x: z.number().int().min(0).default(0), y: z.number().int().min(0).default(0), width: z.number().int().min(2).max(7680).multipleOf(2), height: z.number().int().min(2).max(7680).multipleOf(2) }, async ({ input, x, y, width, height }) => encode(['-i', await localFile(input), '-vf', `crop=${width}:${height}:${x}:${y}`, '-map', '0:v:0', '-map', '0:a:0?', ...videoEncoding, '-c:a', 'aac', '-movflags', '+faststart']));
  tool(server, 'clip_loop', 'Loop a clip a finite number of times (video and audio).', { input: z.string(), count: z.number().int().min(1).max(100) }, async ({ input, count }) => encode(['-stream_loop', String(count - 1), '-i', await localFile(input), '-map', '0:v:0', '-map', '0:a:0?', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', ...videoEncoding, '-c:a', 'aac', '-movflags', '+faststart']));
  tool(server, 'clip_format_convert', 'Convert to MP4, MOV, MKV or WebM, with optional scale and pad.', { input: z.string(), format: z.enum(['mp4', 'mov', 'mkv', 'webm']).default('mp4'), width: z.number().int().min(2).max(7680).multipleOf(2).optional(), height: z.number().int().min(2).max(7680).multipleOf(2).optional() }, async ({ input, format, width, height }) => {
    if ((width === undefined) !== (height === undefined)) throw new Error('Fournir width et height ensemble');
    const filter = width && height ? `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1` : 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
    return encode(['-i', await localFile(input), '-map', '0:v:0', '-map', '0:a:0?', '-vf', filter, ...(format === 'webm' ? ['-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-c:a', 'libopus'] : [...videoEncoding, '-c:a', 'aac']), ...(['mp4', 'mov'].includes(format) ? ['-movflags', '+faststart'] : [])], format);
  });
}
