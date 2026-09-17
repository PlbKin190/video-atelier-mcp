import path from 'node:path';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { tool, localFile, workDir, run, encode, outputPath, positive, nonnegative, type ToolServer, enregistrer } from './media.js';
import { videoEncoding } from './cut.js';

function timestamp(seconds: number): string {
  const ms = Math.round(seconds * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}
export function registerCaptions(server: ToolServer): void {
  tool(server, 'captions_write_srt', 'Write UTF-8 SRT subtitles. No external service, no key.', { segments: z.array(z.object({ start: nonnegative, end: positive, text: z.string().min(1).max(10000) })).min(1).max(10000) }, async ({ segments }) => {
    let previousEnd = 0;
    const blocks = segments.map((segment, index) => {
      if (segment.end <= segment.start || segment.start < previousEnd || Math.round(segment.end * 1000) <= Math.round(segment.start * 1000)) throw new Error('Segments ordonnés, sans chevauchement, durée minimale 1 ms');
      previousEnd = segment.end;
      const text = segment.text.replace(/\r/g, '').replace(/\n\s*\n/g, '\n').trim();
      if (!text) throw new Error('Texte vide');
      return `${index + 1}\n${timestamp(segment.start)} --> ${timestamp(segment.end)}\n${text}\n`;
    });
    const file = outputPath('srt'); await writeFile(file, blocks.join('\n'), 'utf8');
    return { ...(await enregistrer(file)), count: segments.length };
  });
  tool(server, 'captions_burn', 'Burn SRT/ASS subtitles into the picture. Needs an ffmpeg built with libass, plus fonts (both ship in the Docker image).', { input: z.string(), subtitles: z.string() }, async ({ input, subtitles }) => {
    const source = await localFile(subtitles); const extension = path.extname(source).toLowerCase();
    if (!['.srt', '.ass'].includes(extension)) throw new Error('Sous-titres .srt ou .ass requis');
    // Copie vers un nom contrôlé, puis échappement des caractères propres au filtre FFmpeg.
    const temporary = await mkdtemp(path.join(workDir, 'tmp', 'captions-'));
    try {
      const staged = path.join(temporary, `captions${extension}`); await copyFile(source, staged);
      const escaped = staged.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "'\\''");
      return await encode(['-i', await localFile(input), '-vf', `subtitles=filename='${escaped}',scale=trunc(iw/2)*2:trunc(ih/2)*2`, '-map', '0:v:0', '-map', '0:a:0?', ...videoEncoding, '-c:a', 'aac', '-movflags', '+faststart']);
    } finally { await rm(temporary, { recursive: true, force: true }); }
  });
  tool(server, 'captions_transcribe', 'Transcribe locally with the Whisper CLI, if installed. No key; the model is downloaded on first use. Not in the base image.', { input: z.string(), language: z.string().regex(/^[a-z]{2,3}$/).optional(), model: z.enum(['tiny', 'base', 'small', 'medium', 'large']).default('base') }, async ({ input, language, model }) => {
    const binary = process.env.WHISPER_PATH || 'whisper';
    // Adaptateur CLI optionnel; version Whisper non identifiée dans le carnet source.
    // L’image de base n’installe pas torch. Contrat CLI à vérifier avec la distribution choisie.
    try { await run(binary, ['--help']); }
    catch { throw new Error('Whisper indisponible. Installer Python et openai-whisper (pip install openai-whisper), ainsi que ffmpeg, ou définir WHISPER_PATH vers sa CLI. Pour rester sans torch, utiliser captions_write_srt puis captions_burn.'); }
    const temporary = await mkdtemp(path.join(workDir, 'tmp', 'whisper-'));
    try {
      const source = path.join(temporary, 'input.wav');
      const { ffmpeg } = await import('./media.js');
      await run(ffmpeg, ['-nostdin', '-y', '-i', await localFile(input), '-vn', '-ac', '1', '-ar', '16000', source]);
      await run(binary, [source, '--model', model, '--output_format', 'srt', '--output_dir', temporary, '--fp16', 'False', ...(language ? ['--language', language] : [])]);
      const text = await readFile(path.join(temporary, 'input.srt'), 'utf8');
      const destination = outputPath('srt'); await writeFile(destination, text);
      return { ...(await enregistrer(destination)), model };
    } finally { await rm(temporary, { recursive: true, force: true }); }
  });
}
