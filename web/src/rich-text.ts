/**
 * RichText : modele unifie pour tout texte stylise dans le Studio.
 *
 * Utilise par :
 *  - Overlays texte de la composition video (static)
 *  - Animations typewriter (text-typing) : vitesse = char_count / (end_t - start_t)
 *  - Eventuellement post LinkedIn, captions, kinetic typography
 *
 * Serialisation : JSON-safe, persistable en DB. Pas de HTML brut.
 */

export interface RichStyle {
  font_family?: string;
  font_size_px?: number;
  font_weight?: 300 | 400 | 500 | 600 | 700 | 800 | 900;
  font_style?: 'normal' | 'italic';
  color?: string;                                            // hex #fff ou rgba
  bg_color?: string;
  text_decoration?: 'none' | 'underline' | 'line-through';
  letter_spacing_px?: number;
}

export interface RichSpan {
  text: string;                                              // peut contenir \n
  style?: RichStyle;
}

export interface RichText {
  spans: RichSpan[];
  block_align?: 'left' | 'center' | 'right' | 'justify';
  line_height?: number;                                      // ex. 1.2
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function plainText(rt: RichText | null | undefined): string {
  if (!rt?.spans) return '';
  return rt.spans.map((s) => s.text).join('');
}

export function charCount(rt: RichText | null | undefined): number {
  return plainText(rt).length;
}

/** Construit un RichText 1-span depuis un string simple. */
export function fromString(text: string, style?: RichStyle): RichText {
  return { spans: [{ text, style }] };
}

/** Slice les premiers `n` caracteres en conservant les styles (pour typewriter). */
export function sliceChars(rt: RichText, n: number): RichText {
  if (n <= 0) return { spans: [], block_align: rt.block_align, line_height: rt.line_height };
  const out: RichSpan[] = [];
  let remaining = n;
  for (const s of rt.spans) {
    if (remaining <= 0) break;
    if (s.text.length <= remaining) {
      out.push(s);
      remaining -= s.text.length;
    } else {
      out.push({ text: s.text.slice(0, remaining), style: s.style });
      remaining = 0;
    }
  }
  return { spans: out, block_align: rt.block_align, line_height: rt.line_height };
}

// ---------------------------------------------------------------------------
// DOM <-> RichText serialisation
// ---------------------------------------------------------------------------

/** Convertit un contenu DOM (Element ou DocumentFragment) en RichText. */
export function fromDom(root: HTMLElement | DocumentFragment): RichText {
  const spans: RichSpan[] = [];
  walk(root, {}, spans);
  return { spans };
}

function walk(node: Node, inheritedStyle: RichStyle, out: RichSpan[]): void {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.nodeValue ?? '';
    if (text.length === 0) return;
    out.push({ text, style: Object.keys(inheritedStyle).length > 0 ? { ...inheritedStyle } : undefined });
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const el = node as HTMLElement;
  // <br> -> newline
  if (el.tagName === 'BR') {
    out.push({ text: '\n', style: Object.keys(inheritedStyle).length > 0 ? { ...inheritedStyle } : undefined });
    return;
  }
  const tagStyle = styleFromElement(el);
  const merged: RichStyle = { ...inheritedStyle, ...tagStyle };
  for (const child of Array.from(el.childNodes)) {
    walk(child, merged, out);
  }
  // Block-level <div>/<p> -> trailing newline (separe les paragraphes du contenteditable)
  if ((el.tagName === 'DIV' || el.tagName === 'P') && el.nextSibling) {
    out.push({ text: '\n' });
  }
}

function styleFromElement(el: HTMLElement): RichStyle {
  const style: RichStyle = {};
  const s = el.style;
  if (s.fontFamily) style.font_family = s.fontFamily.replace(/['"]/g, '');
  if (s.fontSize) {
    const m = s.fontSize.match(/^(\d+(?:\.\d+)?)px$/);
    if (m) style.font_size_px = parseFloat(m[1]);
  }
  if (s.fontWeight) {
    const w = parseInt(s.fontWeight, 10);
    if (!isNaN(w)) style.font_weight = w as RichStyle['font_weight'];
    else if (s.fontWeight === 'bold') style.font_weight = 700;
    else if (s.fontWeight === 'normal') style.font_weight = 400;
  }
  if (s.fontStyle === 'italic') style.font_style = 'italic';
  if (s.color) style.color = s.color;
  if (s.backgroundColor) style.bg_color = s.backgroundColor;
  if (s.textDecorationLine === 'underline' || s.textDecoration === 'underline') style.text_decoration = 'underline';
  if (s.textDecorationLine === 'line-through' || s.textDecoration === 'line-through') style.text_decoration = 'line-through';
  if (s.letterSpacing) {
    const m = s.letterSpacing.match(/^(-?\d+(?:\.\d+)?)px$/);
    if (m) style.letter_spacing_px = parseFloat(m[1]);
  }
  // Semantic tags fallback
  if (el.tagName === 'B' || el.tagName === 'STRONG') style.font_weight = 700;
  if (el.tagName === 'I' || el.tagName === 'EM') style.font_style = 'italic';
  if (el.tagName === 'U') style.text_decoration = 'underline';
  return style;
}

/** Convertit un RichText en HTML string injectable dans contenteditable. */
export function toHtml(rt: RichText | null | undefined): string {
  if (!rt?.spans?.length) return '';
  return rt.spans
    .map((sp) => {
      const text = (sp.text ?? '').replace(/\n/g, '<br>');
      const css = styleToCss(sp.style);
      if (!css) return escapeHtml(text).replace(/&lt;br&gt;/g, '<br>');
      return `<span style="${css}">${escapeHtml(text).replace(/&lt;br&gt;/g, '<br>')}</span>`;
    })
    .join('');
}

function styleToCss(style?: RichStyle): string {
  if (!style) return '';
  const parts: string[] = [];
  if (style.font_family) parts.push(`font-family:${style.font_family}`);
  if (style.font_size_px) parts.push(`font-size:${style.font_size_px}px`);
  if (style.font_weight) parts.push(`font-weight:${style.font_weight}`);
  if (style.font_style && style.font_style !== 'normal') parts.push(`font-style:${style.font_style}`);
  if (style.color) parts.push(`color:${style.color}`);
  if (style.bg_color) parts.push(`background-color:${style.bg_color}`);
  if (style.text_decoration && style.text_decoration !== 'none') parts.push(`text-decoration:${style.text_decoration}`);
  if (style.letter_spacing_px) parts.push(`letter-spacing:${style.letter_spacing_px}px`);
  return parts.join(';');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
