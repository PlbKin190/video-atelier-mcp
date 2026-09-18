import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { tool, idSchema, positive, nonnegative, recordPath, atomicJson, readJson, mediaPath, probe, type ToolServer } from './media.js';

export const audioTrackSchema = z.object({ media_id: idSchema, start: nonnegative.default(0), trim_start: nonnegative.default(0), duration: positive.optional(), volume: z.number().finite().min(0).max(10).default(1) });
export const clipSchema = z.object({ id: idSchema, media_id: idSchema, in: nonnegative, duration: positive });
export const overlaySchema = z.object({ id: idSchema, media_id: idSchema, start: nonnegative, duration: positive, x: z.number().int().min(0), y: z.number().int().min(0), width: z.number().int().min(2).max(7680), height: z.number().int().min(2).max(7680) });
const percentageSchema = z.number().finite().min(0).max(100);
const textColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Couleur attendue : #RRGGBB');
export const textOverlaySchema = z.object({
  id: idSchema, text: z.string().min(1).max(500), start: nonnegative, duration: positive,
  x_pct: percentageSchema, y_pct: percentageSchema, w_pct: percentageSchema.default(84),
  font_size_px: positive.default(48), color: textColorSchema.default('#FFFFFF'),
  bg_color: z.union([textColorSchema, z.literal('transparent')]).default('transparent'),
  align: z.enum(['left', 'center', 'right']).default('center'), font_family: z.string().optional()
});
export const compositionSchema = z.object({
  id: idSchema, name: z.string(), width: z.number().int().positive().multipleOf(2), height: z.number().int().positive().multipleOf(2), fps: z.number().int().positive(), created_at: z.string(), updated_at: z.string(),
  clips: z.array(clipSchema), overlays: z.array(overlaySchema),
  texts: z.array(textOverlaySchema).default([]),
  transitions: z.array(z.object({ after_clip_id: idSchema, type: z.literal('fade_black'), duration: positive })),
  audio: z.object({ original_volume: z.number().finite().min(0).max(10), tracks: z.array(audioTrackSchema) })
});
export type Composition = z.infer<typeof compositionSchema>;
export type AudioTrack = z.infer<typeof audioTrackSchema>;
const locks = new Map<string, Promise<unknown>>();
export async function loadComp(id: string): Promise<Composition> { return compositionSchema.parse(await readJson(recordPath('compositions', id))); }
export async function saveComp(comp: Composition): Promise<void> { comp.updated_at = new Date().toISOString(); await atomicJson(recordPath('compositions', comp.id), compositionSchema.parse(comp)); }
export async function mutateComp(id: string, change: (comp: Composition) => void | Promise<void>): Promise<Composition> {
  const prior = locks.get(id) || Promise.resolve();
  const pending = prior.catch(() => undefined).then(async () => { const comp = await loadComp(id); await change(comp); await saveComp(comp); return comp; });
  locks.set(id, pending);
  try { return await pending; } finally { if (locks.get(id) === pending) locks.delete(id); }
}
export function totalDuration(comp: Composition): number { return comp.clips.reduce((sum, clip) => sum + clip.duration, 0); }
export async function validateComp(comp: Composition): Promise<{ valid: boolean; errors: string[]; duration: number }> {
  const errors: string[] = []; const duration = totalDuration(comp);
  if (!comp.clips.length) errors.push('Add at least one video clip.');
  for (const clip of comp.clips) {
    try {
      const info = await probe(await mediaPath(clip.media_id));
      if (!info.streams.some(stream => stream.codec_type === 'video')) errors.push(`Clip ${clip.id}: no video track`);
      const length = Number(info.format?.duration);
      if (!Number.isFinite(length) || clip.in + clip.duration > length + 0.05) errors.push(`Clip ${clip.id}: source is too short, or its duration is unknown`);
    } catch (error) { errors.push(`Clip ${clip.id}: ${String(error)}`); }
  }
  for (const overlay of comp.overlays) {
    if (overlay.start + overlay.duration > duration) errors.push(`Overlay ${overlay.id}: runs past the end of the composition`);
    if (overlay.x + overlay.width > comp.width || overlay.y + overlay.height > comp.height) errors.push(`Overlay ${overlay.id}: falls outside the frame`);
    try { if (!(await probe(await mediaPath(overlay.media_id))).streams.some(s => s.codec_type === 'video')) errors.push(`Overlay ${overlay.id}: an image or video is required`); }
    catch (error) { errors.push(`Overlay ${overlay.id}: ${String(error)}`); }
  }
  for (const text of comp.texts) {
    const parsed = textOverlaySchema.safeParse(text);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) errors.push(`Texte ${text.id}: ${issue.path.join('.')}: ${issue.message}`);
    }
    if (text.start >= duration || text.start + text.duration > duration) errors.push(`Text ${text.id}: runs past the end of the composition`);
  }
  for (const transition of comp.transitions) {
    const index = comp.clips.findIndex(clip => clip.id === transition.after_clip_id);
    if (index < 0 || index === comp.clips.length - 1) errors.push('Transition sans paire de clips');
    else if (transition.duration * 2 > Math.min(comp.clips[index]!.duration, comp.clips[index + 1]!.duration)) errors.push('Transition too long: at most half the duration of each clip');
  }
  for (const track of comp.audio.tracks) {
    if (track.start >= duration) errors.push('Audio track starts after the composition ends');
    try {
      const info = await probe(await mediaPath(track.media_id));
      if (!info.streams.some(s => s.codec_type === 'audio')) errors.push(`Media ${track.media_id}: no audio`);
      const length = Number(info.format?.duration);
      if (Number.isFinite(length) && (track.trim_start >= length || (track.duration !== undefined && track.trim_start + track.duration > length + 0.05))) errors.push(`Media ${track.media_id}: audio range falls outside the source`);
    } catch (error) { errors.push(`Audio: ${String(error)}`); }
  }
  return { valid: errors.length === 0, errors, duration };
}
export function registerTimeline(server: ToolServer): void {
  tool(server, 'comp_create', 'Create a sequential composition, stored locally as JSON. No API, no database.', { name: z.string().min(1).max(240), width: z.number().int().min(2).max(7680).multipleOf(2).default(1920), height: z.number().int().min(2).max(7680).multipleOf(2).default(1080), fps: z.number().int().min(1).max(120).default(30) }, async args => {
    const now = new Date().toISOString();
    const comp: Composition = { ...args, id: randomUUID(), created_at: now, updated_at: now, clips: [], overlays: [], texts: [], transitions: [], audio: { original_volume: 1, tracks: [] } };
    await saveComp(comp); return comp;
  });
  tool(server, 'comp_add_clip', 'Append a video clip to the composition.', { comp_id: idSchema, media_id: idSchema, in: nonnegative.default(0), duration: positive }, async ({ comp_id, ...clip }) => { await mediaPath(clip.media_id); return mutateComp(comp_id, comp => { comp.clips.push({ id: randomUUID(), ...clip }); }); });
  tool(server, 'comp_add_overlay', 'Add an image or video overlay (overlay video is muted, last frame held).', { comp_id: idSchema, media_id: idSchema, start: nonnegative.default(0), duration: positive, x: z.number().int().min(0).default(0), y: z.number().int().min(0).default(0), width: z.number().int().min(2).max(7680), height: z.number().int().min(2).max(7680) }, async ({ comp_id, ...overlay }) => { await mediaPath(overlay.media_id); return mutateComp(comp_id, comp => { comp.overlays.push({ id: randomUUID(), ...overlay }); }); });
  tool(server, 'comp_add_transition', 'Fade to black then back, with no overlap and no change in duration. Not a crossfade.', { comp_id: idSchema, after_clip_id: idSchema, type: z.literal('fade_black').default('fade_black'), duration: positive }, async ({ comp_id, ...transition }) => mutateComp(comp_id, comp => {
    const index = comp.clips.findIndex(c => c.id === transition.after_clip_id);
    if (index < 0 || index === comp.clips.length - 1) throw new Error('Add both clips before the transition');
    if (transition.duration * 2 > Math.min(comp.clips[index]!.duration, comp.clips[index + 1]!.duration)) throw new Error('Fondu trop long');
    comp.transitions = comp.transitions.filter(t => t.after_clip_id !== transition.after_clip_id); comp.transitions.push(transition);
  }));
  tool(server, 'comp_set_audio_mix', 'Replace the audio mix of a composition.', { comp_id: idSchema, original_volume: z.number().finite().min(0).max(10).default(1), tracks: z.array(audioTrackSchema).max(32) }, async ({ comp_id, ...audio }) => mutateComp(comp_id, comp => { comp.audio = audio; }));
  tool(server, 'comp_get_timeline', 'Read the composition JSON and its total duration.', { comp_id: idSchema }, async ({ comp_id }) => { const comp = await loadComp(comp_id); return { ...comp, duration: totalDuration(comp) }; });
  tool(server, 'comp_validate', 'Validate references, time ranges, transitions and media before rendering.', { comp_id: idSchema }, async ({ comp_id }) => validateComp(await loadComp(comp_id)));
  tool(server, 'comp_add_text', 'Add a text overlay with percentage positions.', { comp_id: idSchema, ...textOverlaySchema.omit({ id: true }).shape }, async ({ comp_id, ...text }) => mutateComp(comp_id, comp => {
    comp.texts.push(textOverlaySchema.parse({ id: randomUUID(), ...text }));
  }));
  tool(server, 'comp_update_text', 'Update only supplied fields of a text overlay.', { comp_id: idSchema, text_id: idSchema, ...textOverlaySchema.omit({ id: true }).partial().shape }, async ({ comp_id, text_id, ...changes }) => mutateComp(comp_id, comp => {
    const index = comp.texts.findIndex(text => text.id === text_id);
    if (index < 0) throw new Error(`Texte introuvable: ${text_id}`);
    const supplied = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined));
    comp.texts[index] = textOverlaySchema.parse({ ...comp.texts[index]!, ...supplied });
  }));
  tool(server, 'comp_remove_text', 'Remove a text overlay by its identifier.', { comp_id: idSchema, text_id: idSchema }, async ({ comp_id, text_id }) => mutateComp(comp_id, comp => {
    const index = comp.texts.findIndex(text => text.id === text_id);
    if (index < 0) throw new Error(`Texte introuvable: ${text_id}`);
    comp.texts.splice(index, 1);
  }));
}
