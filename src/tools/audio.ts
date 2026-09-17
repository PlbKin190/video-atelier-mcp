import { z } from 'zod';
import { tool, localFile, encode, probe, idSchema, positive, nonnegative, type ToolServer } from './media.js';
import { audioTrackSchema, mutateComp } from './timeline.js';

export interface MixInput { path: string; volume: number; start: number; trim_start: number; duration?: number }
// Portage du principe amix: video-studio-mcp/src/tools/ffmpeg-primitives.ts:130-155.
export function mixGraph(tracks: MixInput[], duration: number): string {
  const filters = tracks.map((track, i) => `[${i}:a:0]atrim=start=${track.trim_start}${track.duration === undefined ? '' : `:duration=${track.duration}`},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${track.volume},adelay=${Math.round(track.start * 1000)}:all=1[a${i}]`);
  filters.push(`${tracks.map((_, i) => `[a${i}]`).join('')}amix=inputs=${tracks.length}:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.95:level=0,apad,atrim=duration=${duration}[a]`);
  return filters.join(';');
}
export function registerAudio(server: ToolServer): void {
  tool(server, 'audio_add_track', 'Add an audio track to the composition.', { comp_id: idSchema, ...audioTrackSchema.shape }, async ({ comp_id, ...track }) => mutateComp(comp_id, comp => { if (comp.audio.tracks.length >= 32) throw new Error('Maximum 32 pistes'); comp.audio.tracks.push(track); }));
  tool(server, 'audio_mix', 'Mix audio or video files into a WAV, with linear gains and offsets in seconds.', { tracks: z.array(z.object({ input: z.string(), volume: z.number().finite().min(0).max(10).default(1), start: nonnegative.default(0), trim_start: nonnegative.default(0), duration: positive.optional() })).min(1).max(32), duration: positive }, async ({ tracks, duration }) => {
    const inputs: MixInput[] = [];
    for (const track of tracks) {
      const file = await localFile(track.input);
      if (!(await probe(file)).streams.some(s => s.codec_type === 'audio')) throw new Error(`Piste audio absente: ${track.input}`);
      inputs.push({ ...track, path: file });
    }
    return encode([...inputs.flatMap(track => ['-i', track.path]), '-filter_complex', mixGraph(inputs, duration), '-map', '[a]', '-vn', '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2'], 'wav');
  });
  tool(server, 'audio_extract', 'Extract the first audio track as WAV, MP3 or AAC/M4A.', { input: z.string(), format: z.enum(['wav', 'mp3', 'm4a']).default('wav') }, async ({ input, format }) => encode(['-i', await localFile(input), '-map', '0:a:0', '-vn', ...(format === 'wav' ? ['-c:a', 'pcm_s16le'] : format === 'mp3' ? ['-c:a', 'libmp3lame', '-b:a', '192k'] : ['-c:a', 'aac', '-b:a', '192k'])], format));
}
