import {
  totalDuration, overlaySchema, textOverlaySchema,
  type Composition,
} from './tools/timeline.js';

export type AspectRatio = '9:16' | '16:9' | '4:5' | '1:1';
export interface EditorOverlay {
  id: string;
  type: 'text' | 'image';
  text?: string;
  image_url?: string;
  x_pct: number;
  y_pct: number;
  w_pct: number;
  h_pct?: number;
  start_t: number;
  end_t: number;
  color?: string;
  font_size_px?: number;
}
export interface EditorData {
  video_url: string;
  aspect_ratio: AspectRatio;
  duration_s: number;
  overlays: EditorOverlay[];
}

function aspectRatio(width: number, height: number): AspectRatio {
  if (!(width > 0 && height > 0 && Number.isFinite(width + height))) {
    throw new Error('Dimensions de composition invalides.');
  }
  // Les dimensions originales restent souveraines au retour. Un format exotique
  // est affiché avec le ratio disponible le plus proche, sans redimensionnement.
  const ratios: [AspectRatio, number][] = [
    ['9:16', 9 / 16], ['16:9', 16 / 9], ['4:5', 4 / 5], ['1:1', 1],
  ];
  return ratios.reduce((best, next) =>
    Math.abs(next[1] - width / height) < Math.abs(best[1] - width / height)
      ? next : best)[0];
}

export function versEditeur(comp: Composition, videoUrl: string): EditorData {
  return {
    video_url: videoUrl,
    aspect_ratio: aspectRatio(comp.width, comp.height),
    duration_s: totalDuration(comp),
    overlays: [
      ...(comp.texts ?? []).map((text): EditorOverlay => ({
        id: text.id, type: 'text', text: text.text,
        x_pct: text.x_pct, y_pct: text.y_pct, w_pct: text.w_pct,
        start_t: text.start, end_t: text.start + text.duration,
        color: text.color, font_size_px: text.font_size_px,
      })),
      ...comp.overlays.map((image): EditorOverlay => ({
        id: image.id, type: 'image',
        image_url: `/media/${encodeURIComponent(image.media_id)}`,
        x_pct: image.x / comp.width * 100,
        y_pct: image.y / comp.height * 100,
        w_pct: image.width / comp.width * 100,
        h_pct: image.height / comp.height * 100,
        start_t: image.start, end_t: image.start + image.duration,
      })),
    ],
  };
}

function mediaId(url: string | undefined): string {
  // Pas d'URL externe ni d'import implicite : seul un média local est réversible.
  const match = /^\/media\/([^/?#]+)$/.exec(url ?? '');
  if (!match) throw new Error('Image attendue sous la forme /media/<id>.');
  const id = decodeURIComponent(match[1]!);
  if (!id || /[/\\]/.test(id)) throw new Error('Identifiant média invalide.');
  return id;
}

/**
 * CONTRAT : depuisEditeur(versEditeur(comp, videoUrl), comp) rend une
 * composition identique à comp, sans mutation (y compris champs inconnus).
 * comp est la base originale conservée côté serveur, jamais un JSON éditeur.
 * Clips, transitions, audio, dimensions, dates et champs non représentables
 * sont conservés. La suppression d'un overlay supprime intentionnellement
 * cet élément. Le ratio, la durée globale et video_url sont des projections,
 * pas des instructions de modification de la timeline.
 */
export function depuisEditeur(data: EditorData, comp: Composition): Composition {
  if (!Array.isArray(data.overlays)) throw new Error('Liste overlays requise.');
  const projected = versEditeur(comp, data.video_url);
  const texts: Composition['texts'] = [];
  const images: Composition['overlays'] = [];
  const seen = new Set<string>();
  for (const overlay of data.overlays) {
    const key = `${overlay.type}:${overlay.id}`;
    if (seen.has(key)) throw new Error(`Overlay dupliqué : ${key}`);
    seen.add(key);
    const before = projected.overlays.find(o => o.id === overlay.id && o.type === overlay.type);
    const oldText = overlay.type === 'text' ? comp.texts?.find(t => t.id === overlay.id) : undefined;
    const oldImage = overlay.type === 'image' ? comp.overlays.find(o => o.id === overlay.id) : undefined;
    const old = oldText ?? oldImage;
    // Évite la dérive (start + duration) - start et px -> % -> px.
    const duration = old && before && overlay.start_t === before.start_t && overlay.end_t === before.end_t
      ? old.duration : overlay.end_t - overlay.start_t;
    if (overlay.type === 'text') {
      const changes = {
        id: overlay.id, text: overlay.text, start: overlay.start_t, duration,
        x_pct: overlay.x_pct, y_pct: overlay.y_pct, w_pct: overlay.w_pct,
        color: overlay.color, font_size_px: overlay.font_size_px,
      };
      const candidate = { ...oldText, ...changes };
      const parsed = textOverlaySchema.parse(candidate);
      // Defaults uniquement pour les nouveaux éléments ; ne pas effacer les
      // extensions que Zod ne connaît pas (bg_color/align/font_family inclus).
      texts.push(oldText ? { ...candidate } as Composition['texts'][number] : parsed);
    } else if (overlay.type === 'image') {
      const pixels = (value: number | undefined, previous: number | undefined,
        original: number | undefined, size: number): number => {
        if (original !== undefined && value === previous) return original;
        if (value === undefined || !Number.isFinite(value)) throw new Error('Géométrie image invalide.');
        return Math.round(value / 100 * size);
      };
      const candidate = {
        ...oldImage, id: overlay.id, media_id: mediaId(overlay.image_url),
        start: overlay.start_t, duration,
        x: pixels(overlay.x_pct, before?.x_pct, oldImage?.x, comp.width),
        y: pixels(overlay.y_pct, before?.y_pct, oldImage?.y, comp.height),
        width: pixels(overlay.w_pct, before?.w_pct, oldImage?.width, comp.width),
        height: pixels(overlay.h_pct, before?.h_pct, oldImage?.height, comp.height),
      };
      overlaySchema.parse(candidate); // Validation sans perdre les extensions.
      images.push(candidate);
    } else {
      throw new Error('Type overlay non représentable.');
    }
  }
  // Ne pas ajouter texts: [] aux anciens documents qui ne le possédaient pas.
  const result = { ...comp, overlays: images };
  if (comp.texts !== undefined || texts.length) result.texts = texts;
  return result;
}
