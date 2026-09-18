<script lang="ts">
  /**
   * RichTextEditor — editeur de texte stylise reutilisable.
   *
   * Usage :
   *   <RichTextEditor value={rt} onchange={(rt) => sel.rich_text = rt} />
   *
   * Caracteristiques :
   *  - Contenteditable + Selection/Range API (pas execCommand deprecated)
   *  - Toolbar : B / I / U / Font / Size / Color / Highlight / Align
   *  - Sortie : RichText (JSON serialisable, persistable en DB)
   *  - Le meme editeur sert pour overlays statiques ET text-typing
   */
  import { fromDom, toHtml, type RichText, type RichStyle } from './rich-text';
  import { TOKEN_WHITE, TOKEN_ORANGE } from './tokens';

  type Props = {
    value: RichText;
    onchange: (rt: RichText) => void;
    compact?: boolean;
    minHeight?: string;
    placeholder?: string;
    displayScale?: number;   // WYSIWYG : scale l'affichage des font_size_px (px canvas) a la taille preview
  };

  let { value, onchange, compact = false, minHeight = '60px', placeholder = 'Enter your text...', displayScale = 1 }: Props = $props();

  let editorEl: HTMLDivElement | null = $state(null);
  let initialized = false;
  let savedRange: Range | null = null;

  // Init innerHTML une seule fois au mount (uncontrolled apres ca pour preserver caret)
  $effect(() => {
    if (editorEl && !initialized) {
      editorEl.innerHTML = toHtml(value) || '';
      initialized = true;
    }
  });

  function saveSelection() {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      const r = sel.getRangeAt(0);
      if (editorEl && editorEl.contains(r.commonAncestorContainer)) {
        savedRange = r.cloneRange();
      }
    }
  }

  function restoreSelection() {
    if (!savedRange) return;
    const sel = window.getSelection();
    if (!sel) return;
    sel.removeAllRanges();
    sel.addRange(savedRange);
  }

  function emitChange() {
    if (!editorEl) return;
    onchange(fromDom(editorEl));
  }

  function applyStyle(style: Partial<RichStyle>) {
    if (!editorEl) return;
    restoreSelection();
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (range.collapsed) return;
    const span = document.createElement('span');
    applyInline(span.style, style);
    try {
      range.surroundContents(span);
    } catch {
      const contents = range.extractContents();
      span.appendChild(contents);
      range.insertNode(span);
    }
    // Restore selection inside the new span
    const newRange = document.createRange();
    newRange.selectNodeContents(span);
    sel.removeAllRanges();
    sel.addRange(newRange);
    emitChange();
  }

  function setBlockAlign(align: 'left' | 'center' | 'right' | 'justify') {
    if (!editorEl) return;
    editorEl.style.textAlign = align;
    const rt = fromDom(editorEl);
    onchange({ ...rt, block_align: align });
  }

  function applyInline(s: CSSStyleDeclaration, style: Partial<RichStyle>): void {
    if (style.font_family) s.fontFamily = style.font_family;
    if (style.font_size_px) s.fontSize = style.font_size_px + 'px';
    if (style.font_weight) s.fontWeight = String(style.font_weight);
    if (style.font_style) s.fontStyle = style.font_style;
    if (style.color) s.color = style.color;
    if (style.bg_color) s.backgroundColor = style.bg_color;
    if (style.text_decoration) s.textDecoration = style.text_decoration;
    if (style.letter_spacing_px) s.letterSpacing = style.letter_spacing_px + 'px';
  }

  function onKeyDown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      applyStyle({ font_weight: 700 });
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'i') {
      e.preventDefault();
      applyStyle({ font_style: 'italic' });
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'u') {
      e.preventDefault();
      applyStyle({ text_decoration: 'underline' });
    }
  }

  // Sanitize collage : strip rich HTML, keep plain text
  function onPaste(e: ClipboardEvent) {
    e.preventDefault();
    const text = e.clipboardData?.getData('text/plain') ?? '';
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    sel.getRangeAt(0).deleteContents();
    sel.getRangeAt(0).insertNode(document.createTextNode(text));
    sel.collapseToEnd();
    emitChange();
  }

  const FONTS = [
    'Inter',
    'DM Sans',
    'JetBrains Mono',
    'IBM Plex Mono',
    'Geist',
    'Roboto',
    'Roboto Mono',
    'Playfair Display',
    'Space Grotesk',
    'Source Code Pro',
    'serif',
    'system-ui'
  ];

  let pickFont = $state('Inter');
  let pickSize = $state(16);
  let pickColor = $state(TOKEN_WHITE);
  let pickBg = $state(TOKEN_ORANGE);
  let showHighlight = $state(false);
  let fontMenuOpen = $state(false);

  // Inject Google Fonts CSS link au mount (idempotent)
  $effect(() => {
    if (document.querySelector('link[data-rte-fonts]')) return;
    const link = document.createElement('link');
    link.setAttribute('data-rte-fonts', '');
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?' + [
      'Inter:wght@300..900',
      'DM+Sans:wght@300..800',
      'JetBrains+Mono:wght@300..800',
      'IBM+Plex+Mono:wght@300..700',
      'Roboto:wght@300..900',
      'Roboto+Mono:wght@300..700',
      'Playfair+Display:wght@400..900',
      'Space+Grotesk:wght@300..700',
      'Source+Code+Pro:wght@300..800'
    ].map(f => 'family=' + f).join('&') + '&display=swap';
    document.head.appendChild(link);
  });
</script>

<div class="rte" class:compact>
  <div class="rte-toolbar">
    <button type="button" onmousedown={(e) => e.preventDefault()} onclick={() => applyStyle({ font_weight: 700 })} title="Bold (Cmd+B)" class="rte-btn"><strong>B</strong></button>
    <button type="button" onmousedown={(e) => e.preventDefault()} onclick={() => applyStyle({ font_style: 'italic' })} title="Italic (Cmd+I)" class="rte-btn"><em>I</em></button>
    <button type="button" onmousedown={(e) => e.preventDefault()} onclick={() => applyStyle({ text_decoration: 'underline' })} title="Underline (Cmd+U)" class="rte-btn"><u>U</u></button>
    <button type="button" onmousedown={(e) => e.preventDefault()} onclick={() => applyStyle({ text_decoration: 'line-through' })} title="Strikethrough" class="rte-btn"><s>S</s></button>
    <span class="rte-sep"></span>
    <div class="rte-font-picker" title="Font">
      <button type="button" class="rte-font-trigger" style:font-family={pickFont} onmousedown={(e) => e.preventDefault()} onclick={() => (fontMenuOpen = !fontMenuOpen)}>
        {pickFont} <span class="rte-chev">▾</span>
      </button>
      {#if fontMenuOpen}
        <ul class="rte-font-menu" role="listbox" onclick={(e) => e.stopPropagation()}>
          {#each FONTS as f (f)}
            <li>
              <button
                type="button"
                class="rte-font-opt"
                class:active={pickFont === f}
                style:font-family={f}
                onmousedown={(e) => e.preventDefault()}
              onclick={() => { pickFont = f; fontMenuOpen = false; applyStyle({ font_family: f }); }}
              >{f}</button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
    <input type="number" min="8" max="200" step="1" bind:value={pickSize} onfocus={saveSelection} onchange={() => applyStyle({ font_size_px: pickSize })} title="Size (px)" class="rte-input rte-num" />
    <span class="rte-sep"></span>
    <label class="rte-swatch" title="Text colour">
      <input type="color" bind:value={pickColor} onfocus={saveSelection} onchange={() => applyStyle({ color: pickColor })} />
      <span class="rte-swatch-dot" style:background={pickColor}></span>
      <span>A</span>
    </label>
    <label class="rte-swatch" title="Highlight">
      <input type="color" bind:value={pickBg} onfocus={saveSelection} onchange={() => applyStyle({ bg_color: pickBg })} />
      <span class="rte-swatch-dot" style:background={pickBg}></span>
      <span>▣</span>
    </label>
    <span class="rte-sep"></span>
    <button type="button" onmousedown={(e) => e.preventDefault()} onclick={() => setBlockAlign('left')} title="Align left" class="rte-btn">⫷</button>
    <button type="button" onmousedown={(e) => e.preventDefault()} onclick={() => setBlockAlign('center')} title="Align center" class="rte-btn">⫶</button>
    <button type="button" onmousedown={(e) => e.preventDefault()} onclick={() => setBlockAlign('right')} title="Align right" class="rte-btn">⫸</button>
  </div>
  <div
    bind:this={editorEl}
    class="rte-content"
    contenteditable="true"
    role="textbox"
    tabindex="0"
    aria-multiline="true"
    aria-label={placeholder}
    style:min-height={minHeight}
    style:zoom={displayScale}
    style:text-align={value?.block_align ?? 'left'}
    oninput={emitChange}
    onkeydown={onKeyDown}
    onpaste={onPaste}
    onblur={saveSelection}
  ></div>
</div>

<style>
  .rte {
    display: flex;
    flex-direction: column;
    gap: 0;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 6px;
    overflow: hidden;
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
  }
  .rte-toolbar {
    display: flex;
    align-items: center;
    gap: 3px;
    padding: 5px 6px;
    background: rgba(255, 255, 255, 0.04);
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    flex-wrap: wrap;
  }
  .rte-btn {
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.1);
    color: var(--text);
    padding: 2px 7px;
    border-radius: 3px;
    cursor: pointer;
    font-size: 11px;
    line-height: 1.2;
    min-width: 22px;
    font-family: inherit;
  }
  .rte-btn:hover { background: rgba(255, 255, 255, 0.12); }
  .rte-input {
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.1);
    color: var(--text);
    padding: 2px 4px;
    border-radius: 3px;
    font-size: 10px;
    font-family: inherit;
    height: 22px;
  }
  .rte-num { width: 44px; }
  /* Font picker custom : preview chaque police dans sa propre typo */
  .rte-font-picker {
    position: relative;
    display: inline-block;
  }
  .rte-font-trigger {
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.1);
    color: var(--text);
    padding: 2px 8px;
    border-radius: 3px;
    font-size: 11px;
    height: 22px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-width: 90px;
    max-width: 130px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .rte-font-trigger:hover { background: rgba(255, 255, 255, 0.12); }
  .rte-chev { font-size: 8px; opacity: 0.6; }
  .rte-font-menu {
    position: absolute;
    top: 100%;
    left: 0;
    margin: 4px 0 0;
    padding: 4px 0;
    list-style: none;
    background: rgba(20, 20, 24, 0.96);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 6px;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.5);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    z-index: 99;
    min-width: 180px;
    max-height: 280px;
    overflow-y: auto;
  }
  .rte-font-opt {
    width: 100%;
    background: transparent;
    border: none;
    color: var(--text);
    padding: 6px 12px;
    text-align: left;
    cursor: pointer;
    font-size: 13px;
    line-height: 1.3;
  }
  .rte-font-opt:hover { background: rgba(255, 255, 255, 0.06); }
  .rte-font-opt.active { background: rgba(255, 91, 20, 0.15); color: var(--accent); }
  .rte-sep {
    width: 1px;
    height: 16px;
    background: rgba(255, 255, 255, 0.1);
    margin: 0 2px;
  }
  .rte-swatch {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 2px 5px;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 3px;
    cursor: pointer;
    font-size: 10px;
    color: var(--text);
  }
  .rte-swatch input[type="color"] {
    position: absolute;
    inset: 0;
    opacity: 0;
    cursor: pointer;
  }
  .rte-swatch-dot {
    width: 10px;
    height: 10px;
    border-radius: 2px;
    border: 1px solid rgba(255, 255, 255, 0.2);
  }
  .rte-content {
    padding: 8px 10px;
    color: var(--text);
    font-size: 13px;
    line-height: 1.4;
    outline: none;
    overflow: auto;
    max-height: 280px;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .rte-content:empty::before {
    content: attr(aria-label);
    color: var(--text-tertiary, rgba(255, 255, 255, 0.3));
    pointer-events: none;
  }
  .rte-content:focus { background: rgba(255, 255, 255, 0.02); }
  .rte.compact .rte-content { font-size: 12px; padding: 6px 8px; max-height: 180px; }
  .rte.compact .rte-toolbar { padding: 3px 4px; }
</style>
