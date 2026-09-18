<script lang="ts">
  import RichTextEditor from './RichTextEditor.svelte';
  import Icon from './Icon.svelte';
  import { fromString, toHtml, sliceChars, charCount, plainText, type RichText } from './rich-text';

  /**
   * VideoCompEditor — Niveau 2 : drag-drop overlays sur video frame.
   * data shape : {
   *   video_url: string,
   *   aspect_ratio: '9:16' | '16:9' | '4:5' | '1:1',
   *   duration_s: number,
   *   overlays: [{ id, type:'text'|'image', text?, image_url?, x_pct, y_pct, w_pct, h_pct, start_t, end_t, color?, font_size_px? }]
   * }
   * On drag end -> PATCH /api/comps/{stepTraceId} avec output_assets.overlays[i] mis à jour.
   */
  interface TextLine {
    text: string;
    color?: string;
    font_size_px?: number;
    font_weight?: number;       // 400-900
    font_family?: string;       // override de la typographie pour cette ligne
  }

  // SAM2 = OPTION par overlay (peu importe le type), pas un track separe.
  interface OverlaySam2 {
    enabled: boolean;
    mode?: 'yolo' | 'point' | 'text';   // null/undef => yolo auto
    point?: [number, number] | null;
    text_prompt?: string;               // mode "Decris" via YOLO-World
    feather_px?: number;
    opacity?: number;
    status?: 'idle' | 'running' | 'done' | 'error';
    progress?: { step: string; percent: number; eta_s: number };
    output_url?: string;
    error?: string;
  }

  interface Overlay {
    id: string;
    type: 'text' | 'image' | 'video';
    enabled?: boolean;                 // visible sur la frame ; default = true
    label?: string;                    // nom editable affiche dans le sticky label timeline
    text?: string;                     // legacy : converti en rich_text au mount
    text_lines?: TextLine[];           // legacy : idem
    rich_text?: RichText;              // source unique pour overlays texte
    typing_animation?: boolean;        // chars reveles progressivement (vitesse auto = char_count / clip_duration)
    image_url?: string;
    video_url?: string;                // pour type='video'
    sam2?: OverlaySam2;                // option SAM2 tracking pour CET overlay
    x_pct: number;
    y_pct: number;
    w_pct: number;
    h_pct: number;
    start_t: number;
    end_t: number;
    color?: string;
    font_family?: string;       // typographie de l'overlay (heritee par les lignes)
    font_size_px?: number;
    font_weight?: number;
    text_align?: 'left' | 'center' | 'right';
    letter_spacing_px?: number;
    line_height?: number;
    bg_color?: string;
    bg_opacity?: number;
    liquid_glass?: boolean;
    border_color?: string;
    border_width_px?: number;
    border_radius_px?: number;
    text_opacity?: number;
    padding_x_px?: number;
    padding_y_px?: number;
  }

  interface Rush {
    start_t: number;             // position dans la timeline (derivee de la sequence)
    end_t: number;               // = start_t + (src_out - src_in)
    video_url?: string;
    duration_s?: number;         // duree native du fichier source
    src_in?: number;             // trim IN dans le fichier source (sec)
    src_out?: number;            // trim OUT dans le fichier source (sec)
    thumbnail_url?: string;
    label?: string;
    color?: string;
  }

  interface SyncPoint {
    t: number;
    label?: string;
  }

  interface MusicClip {
    url?: string;
    start_t: number;
    end_t: number;
    volume?: number;
    name?: string;
    waveform?: number[];   // pre-computed amplitude bins
  }

  interface CompData {
    video_url?: string;
    aspect_ratio?: '9:16' | '16:9' | '4:5' | '1:1';
    duration_s?: number;
    overlays?: Overlay[];
    rushes?: Rush[];
    audio_waveform?: number[];
    audio_sync_points?: SyncPoint[];
    audio_volume?: number;          // 0..1, master voiceover
    music_track?: MusicClip;
    sam2Regions?: Sam2Region[];     // incrustations persistees (DB)
  }

  let { data, metadata }: { data: unknown; metadata?: Record<string, unknown> } = $props();

  const comp: CompData = $derived.by(() => {
    if (typeof data === 'string') { try { return JSON.parse(data); } catch { return {}; } }
    if (data && typeof data === 'object') return data as CompData;
    return {};
  });

  const aspectRatio = $derived(comp.aspect_ratio ?? '9:16');
  const AR_CSS: Record<string, string> = { '9:16': '9 / 16', '16:9': '16 / 9', '4:5': '4 / 5', '1:1': '1 / 1' };
  // Largeur du canvas de rendu (px) : 16:9 = 1920, les formats verticaux/carre = 1080.
  // font_size_px est exprime dans ces coords -> on scale a la taille reelle de la preview
  // (frameW) pour que les overlays aient la meme taille relative qu au rendu final.
  const CANVAS_W = $derived(aspectRatio === '16:9' ? 1920 : 1080);
  let frameW = $state(0);

  // Working overlays : si l user a edite -> override (state), sinon = source (data).
  let overrideOverlays = $state<Overlay[] | null>(null);
  const overlays = $derived(overrideOverlays ?? comp?.overlays ?? []);
  let currentTime = $state(0);
  let videoEl: HTMLVideoElement | null = $state(null);
  let videoMeta = $state<{ w: number; h: number } | null>(null);
  // Sprite-image unique de toutes les frames echantillonnees (timeline-aligned, scale au zoom).
  let masterFilmstrip = $state<string | null>(null);
  // Filmstrips (sprite per overlay video : ov.id -> data URL)
  let overlayFilmstrips = $state<Record<string, string>>({});
  // Refs sur les <video> overlays pour sync currentTime (pas autoplay/loop)
  let overlayVideoEls = $state<Record<string, HTMLVideoElement | undefined>>({});

  // Sync chaque overlay video au currentTime de la composition (pas de loop independant)
  $effect(() => {
    const t = currentTime;
    for (const ov of overlays) {
      if (ov.type !== 'video') continue;
      const vEl = overlayVideoEls[ov.id];
      if (!vEl) continue;
      // Position dans la timeline relative au start_t de l overlay
      const localT = Math.max(0, Math.min(vEl.duration || ov.end_t - ov.start_t, t - ov.start_t));
      // Seek si differe de plus de 50ms (evite spam)
      if (Math.abs(vEl.currentTime - localT) > 0.05) {
        try { vEl.currentTime = localT; } catch { /* ignore seek errors */ }
      }
      // Toujours en pause : on scrub manuel via timeline
      if (!vEl.paused) vEl.pause();
    }
  });

  function onVideoMeta() {
    if (videoEl) {
      videoMeta = { w: videoEl.videoWidth, h: videoEl.videoHeight };
    }
    // NB : le filmstrip n'est PLUS regenere ici (sinon il repart a chaque switch de rush
    // pendant le scrub et ne se stabilise jamais). Il est genere depuis la liste des rushes
    // via un $effect dedie (multi-rush, une fois par jeu de rushes).
  }

  // Filmstrip MULTI-RUSH : echantillonne CHAQUE rush sur son segment [src_in,src_out] et
  // compose une sprite horizontale continue alignee sur la timeline (nb de frames par rush
  // proportionnel a sa duree). Stretchee 100% sur la piste. Genere une seule fois par jeu
  // de rushes (via $effect ci-dessous), pas a chaque switch video.
  let filmstripBusy = false;
  async function generateMasterFilmstrip() {
    const rs = (rushes || []).filter((r) => r.video_url);
    if (!rs.length || !totalDur || filmstripBusy) return;
    filmstripBusy = true;
    try {
      const THUMB_W = 120;
      const arH = aspectRatio === '16:9' ? 9 / 16 : aspectRatio === '1:1' ? 1 : aspectRatio === '4:5' ? 5 / 4 : 16 / 9;
      const THUMB_H = Math.round(THUMB_W * arH);
      const plan = rs.map((r) => ({ r, n: Math.max(1, Math.round(((r.end_t - r.start_t) / totalDur) * 36)) }));
      const totalFrames = plan.reduce((a, p) => a + p.n, 0);
      const composite = document.createElement('canvas');
      composite.width = THUMB_W * totalFrames;
      composite.height = THUMB_H;
      const ctx = composite.getContext('2d');
      if (!ctx) return;
      let xi = 0;
      for (const { r, n } of plan) {
        const probe = document.createElement('video');
        probe.src = r.video_url!;
        probe.muted = true; probe.crossOrigin = 'anonymous'; probe.preload = 'auto';
        await new Promise((res) => { probe.onloadeddata = res; probe.onerror = res; setTimeout(res, 3000); });
        const sin = r.src_in ?? 0;
        const sout = r.src_out ?? probe.duration ?? (sin + 1);
        for (let i = 0; i < n; i++) {
          const t = n === 1 ? (sin + sout) / 2 : sin + (i / (n - 1)) * (sout - sin);
          try { probe.currentTime = Math.max(0, Math.min(probe.duration || sout, t)); } catch { /* */ }
          await new Promise((res) => { probe.onseeked = res; setTimeout(res, 230); });
          try { ctx.drawImage(probe, xi * THUMB_W, 0, THUMB_W, THUMB_H); } catch { /* skip */ }
          xi++;
        }
      }
      masterFilmstrip = composite.toDataURL('image/jpeg', 0.6);
    } finally {
      filmstripBusy = false;
    }
  }

  // Regenere le filmstrip UNE fois par jeu de rushes (signature url+timing), pas au scrub.
  let lastFilmstripKey = '';
  $effect(() => {
    const key = (rushes || []).map((r) => `${r.video_url}@${r.start_t}-${r.end_t}`).join('|');
    if (key && key !== lastFilmstripKey) {
      lastFilmstripKey = key;
      generateMasterFilmstrip().catch(() => { /* ignore */ });
    }
  });

  // Genere un filmstrip frame-by-frame pour un overlay video (sprite N frames).
  async function generateOverlayFilmstrip(ovId: string, src: string, n = 24) {
    if (overlayFilmstrips[ovId]) return;                   // deja genere
    const probe = document.createElement('video');
    probe.src = src;
    probe.muted = true;
    probe.crossOrigin = 'anonymous';
    probe.preload = 'auto';
    await new Promise((res) => { probe.onloadeddata = res; probe.onerror = () => res(null); setTimeout(res, 4000); });
    if (!probe.duration || probe.duration === Infinity) return;
    const dur = probe.duration;
    const aspectH = Math.round(120 * (probe.videoHeight / probe.videoWidth || 0.5625));
    const composite = document.createElement('canvas');
    composite.width = 120 * n;
    composite.height = aspectH;
    const ctx = composite.getContext('2d');
    if (!ctx) return;
    for (let i = 0; i < n; i++) {
      const t = (i / Math.max(1, n - 1)) * dur;
      probe.currentTime = t;
      await new Promise((res) => { probe.onseeked = res; setTimeout(res, 180); });
      try { ctx.drawImage(probe, i * 120, 0, 120, aspectH); } catch { /* skip */ }
    }
    overlayFilmstrips = { ...overlayFilmstrips, [ovId]: composite.toDataURL('image/jpeg', 0.5) };
  }

  // Trigger overlay filmstrip generation chaque fois qu un overlay video apparait
  $effect(() => {
    for (const ov of overlays) {
      if (ov.type !== 'video') continue;
      const src = ov.video_url || ov.image_url || '';
      if (!src) continue;
      const isVideo = src.endsWith('.mp4') || src.endsWith('.webm') || src.endsWith('.mov') || src.startsWith('data:video');
      if (!isVideo) continue;
      if (overlayFilmstrips[ov.id]) continue;
      generateOverlayFilmstrip(ov.id, src).catch(() => {});
    }
  });

  let frameEl: HTMLDivElement | null = $state(null);
  let selectedId = $state<string | null>(null);
  let dirty = $state(false);
  let saving = $state(false);
  let saveMsg = $state<string | null>(null);

  function ensureOverride() {
    if (overrideOverlays === null) {
      // JSON-clone evite structuredClone qui peut throw sur les proxy Svelte
      const src = comp?.overlays ?? [];
      overrideOverlays = JSON.parse(JSON.stringify(src));
    }
  }

  // Auto-select premier overlay UNE SEULE FOIS au mount (sinon le deselect est annule).
  let initialAutoSelectDone = $state(false);
  $effect(() => {
    if (!initialAutoSelectDone && overlays.length > 0) {
      selectedId = overlays[0].id;
      initialAutoSelectDone = true;
    }
  });

  // Filter overlays visible at currentTime (et enabled != false)
  const visibleOverlays = $derived(
    overlays.filter((o) => o.enabled !== false && currentTime >= o.start_t && currentTime <= o.end_t)
  );

  function toggleOverlayEnabled(id: string, e: Event) {
    e.stopPropagation();
    ensureOverride();
    if (!overrideOverlays) return;
    const idx = overrideOverlays.findIndex((o) => o.id === id);
    if (idx < 0) return;
    const o = { ...overrideOverlays[idx] };
    o.enabled = o.enabled === false ? true : false;
    overrideOverlays[idx] = o;
    dirty = true;
  }

  function onTimeUpdate() {
    // En scrub / pause, c'est seekTo qui possede currentTime. onTimeUpdate ne pilote la
    // timeline QU'EN LECTURE, sinon les seeks de chargement (videoEl.currentTime=0 quand un
    // rush change) ecrasent la position de scrub -> "toujours le meme rush".
    if (!videoEl || !playing) return;
    // Montage playback : le <video> ne contient qu'UN rush a la fois. videoEl.currentTime
    // est le temps LOCAL dans le fichier rush ; le temps GLOBAL timeline =
    // activeRush.start_t + (local - src_in). Sans ca, le playhead retombe dans la fenetre
    // du 1er rush -> "toujours le meme rush" (bug multi-rush).
    if (!activeRush) { currentTime = videoEl.currentTime; return; }
    const srcIn = activeRush.src_in ?? 0;
    const allocated = activeRush.end_t - activeRush.start_t;
    const srcOut = activeRush.src_out ?? (srcIn + allocated);
    // Fin de la fenetre source de ce rush -> avance au rush suivant (UNIQUEMENT en lecture ;
    // en scrub/pause on ne saute pas, on mappe juste le temps global).
    if (playing && videoEl.currentTime >= srcOut - 0.03) {
      const idx = rushes.indexOf(activeRush);
      const next = rushes[idx + 1];
      if (next && next.video_url) {
        currentTime = next.start_t + 0.001;   // -> activeRush switch -> $effect recharge+seek (+resume)
      } else {
        currentTime = activeRush.end_t;
        if (!videoEl.paused) videoEl.pause();
      }
      return;
    }
    currentTime = activeRush.start_t + Math.max(0, videoEl.currentTime - srcIn);
  }

  // Drag logic
  let dragState: { id: string; startX: number; startY: number; startXPct: number; startYPct: number; mode: 'move' | 'resize' } | null = null;

  function startDrag(e: PointerEvent, ov: Overlay, mode: 'move' | 'resize' = 'move') {
    if (!frameEl) return;
    e.preventDefault();
    e.stopPropagation();
    ensureOverride();
    selectedId = ov.id;
    dragState = {
      id: ov.id,
      startX: e.clientX,
      startY: e.clientY,
      startXPct: mode === 'move' ? ov.x_pct : ov.w_pct,
      startYPct: mode === 'move' ? ov.y_pct : ov.h_pct,
      mode
    };
    window.addEventListener('pointermove', onDrag);
    window.addEventListener('pointerup', endDrag, { once: true });
  }

  function onDrag(e: PointerEvent) {
    if (!dragState || !frameEl || !overrideOverlays) return;
    const rect = frameEl.getBoundingClientRect();
    const dx = ((e.clientX - dragState.startX) / rect.width) * 100;
    const dy = ((e.clientY - dragState.startY) / rect.height) * 100;
    const idx = overrideOverlays.findIndex((o) => o.id === dragState!.id);
    if (idx < 0) return;
    const ov = overrideOverlays[idx];
    const r = (v: number) => Math.round(v * 10) / 10;  // 1 decimal max
    if (dragState.mode === 'move') {
      ov.x_pct = r(Math.max(0, Math.min(100 - ov.w_pct, dragState.startXPct + dx)));
      ov.y_pct = r(Math.max(0, Math.min(100 - ov.h_pct, dragState.startYPct + dy)));
    } else {
      ov.w_pct = r(Math.max(5, Math.min(100 - ov.x_pct, dragState.startXPct + dx)));
      ov.h_pct = r(Math.max(5, Math.min(100 - ov.y_pct, dragState.startYPct + dy)));
    }
    overrideOverlays[idx] = { ...ov };
    dirty = true;
  }

  function endDrag() {
    window.removeEventListener('pointermove', onDrag);
    dragState = null;
  }

  // ---- Versions (history snapshots) ----
  let versionsOpen = $state(false);
  let versions = $state<Array<{ idx: number; ts: string; label?: string | null }>>([]);
  let versionsLoading = $state(false);

  async function loadVersions() {
    const stepTraceId = (metadata?.step_trace_id ?? metadata?.stepTraceId) as number | undefined;
    if (!stepTraceId) return;
    versionsLoading = true;
    try {
      const res = await fetch(`/api/comps/${stepTraceId}/versions`);
      if (res.ok) {
        const json = await res.json();
        versions = json.versions ?? [];
      }
    } finally {
      versionsLoading = false;
    }
  }

  async function restoreVersion(idx: number) {
    const stepTraceId = (metadata?.step_trace_id ?? metadata?.stepTraceId) as number | undefined;
    if (!stepTraceId) return;
    if (!confirm(`Restaurer la version #${idx} ? La version courante sera snapshotee.`)) return;
    saving = true;
    try {
      const res = await fetch(`/api/comps/${stepTraceId}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'restore', idx })
      });
      if (res.ok) {
        saveMsg = `Restored version #${idx} - reload pour voir`;
        setTimeout(() => window.location.reload(), 600);
      } else {
        saveMsg = `Restore failed (${res.status})`;
      }
    } finally {
      saving = false;
    }
  }

  async function save() {
    // Cherche step_trace_id dans metadata OU dans le ?step_trace_id query param (lecture URL)
    let stepTraceId = (metadata?.step_trace_id ?? metadata?.stepTraceId) as number | undefined;
    if (!stepTraceId && typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const fromUrl = params.get('step_trace_id');
      if (fromUrl) stepTraceId = Number(fromUrl);
    }
    // Fallback : metadata.id (parfois present)
    if (!stepTraceId && metadata?.id) stepTraceId = Number(metadata.id);
    if (!stepTraceId) {
      saveMsg = 'step_trace_id manquant (passe via metadata ou ?step_trace_id=)';
      return;
    }
    saving = true;
    saveMsg = null;
    try {
      // Snapshot complet de TOUT le montage : data + state UI + preferences editeur.
      const snapshot = {
        ...comp,
        // Overlays (source unique de verite apres unification)
        overlays: overrideOverlays ?? overlays,
        sam2Regions: sam2Regions,        // transitoire, vide apres migration
        rushes: rushesOverride ?? rushes,
        // Track enable flags (audio / video master / music)
        video_track_enabled: videoTrackEnabled,
        audio_track_enabled: audioTrackEnabled,
        music_track_enabled: musicTrackEnabled,
        // Volumes (master)
        audio_volume: audioVolume,
        music_volume: musicVolume,
        // Editor preferences (UI state persistee)
        editor_state: {
          expanded_tracks: expandedTracks,
          sticky_col_width: stickyColWidth,
          zoom,
          show_frames: showFrames,
          show_waveform: showWaveform,
          show_sync: showSync,
          show_music: showMusic,
        }
      };
      const res = await fetch(`/api/comps/${stepTraceId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ output_assets: snapshot })
      });
      if (!res.ok) {
        const t = await res.text();
        saveMsg = `Save failed (${res.status}): ${t.slice(0, 120)}`;
      } else {
        const json = await res.json().catch(() => ({}));
        saveMsg = `Saved ${(overrideOverlays ?? overlays).length} overlays`;
        console.log('[save] ok', json);
        dirty = false;
      }
    } catch (e) {
      saveMsg = `Network error: ${(e as Error).message}`;
    } finally {
      saving = false;
    }
  }

  function selectOverlay(id: string) {
    selectedId = id;
    selectedSam2Id = null;        // mutual exclusion sam2
  }

  // ---- Reorder overlays vertically (drag handle dans sticky label) ----
  let reorderDrag = $state<{ id: string; startY: number; startIdx: number; currentIdx: number } | null>(null);

  function startReorderDrag(e: PointerEvent, id: string) {
    e.preventDefault();
    e.stopPropagation();
    ensureOverride();
    if (!overrideOverlays) return;
    const idx = overrideOverlays.findIndex((o) => o.id === id);
    if (idx < 0) return;
    reorderDrag = { id, startY: e.clientY, startIdx: idx, currentIdx: idx };
    window.addEventListener('pointermove', onReorderDrag);
    window.addEventListener('pointerup', endReorderDrag, { once: true });
  }
  function onReorderDrag(e: PointerEvent) {
    if (!reorderDrag || !overrideOverlays) return;
    // Calcule la row sous le pointer
    const target = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    const rowEl = target?.closest('.track-row');
    if (!rowEl) return;
    const targetId = rowEl.querySelector('.reorder-handle')?.getAttribute('data-overlay-id');
    if (!targetId || targetId === reorderDrag.id) return;
    const targetIdx = overrideOverlays.findIndex((o) => o.id === targetId);
    if (targetIdx < 0) return;
    // Swap
    const arr = [...overrideOverlays];
    const [moved] = arr.splice(reorderDrag.currentIdx, 1);
    arr.splice(targetIdx, 0, moved);
    overrideOverlays = arr;
    reorderDrag.currentIdx = targetIdx;
    dirty = true;
  }
  function endReorderDrag() {
    window.removeEventListener('pointermove', onReorderDrag);
    reorderDrag = null;
  }

  function deleteOverlay(id: string) {
    ensureOverride();
    if (overrideOverlays) overrideOverlays = overrideOverlays.filter((o) => o.id !== id);
    if (selectedId === id) selectedId = null;
    dirty = true;
  }

  // Alignement : H = 'left'|'center'|'right', V = 'top'|'middle'|'bottom'
  function alignOverlay(ov: Overlay, h: 'left' | 'center' | 'right' | null, v: 'top' | 'middle' | 'bottom' | null) {
    ensureOverride();
    if (!overrideOverlays) return;
    const idx = overrideOverlays.findIndex((o) => o.id === ov.id);
    if (idx < 0) return;
    const o = { ...overrideOverlays[idx] };
    if (h === 'left') o.x_pct = 0;
    else if (h === 'center') o.x_pct = Math.max(0, (100 - o.w_pct) / 2);
    else if (h === 'right') o.x_pct = Math.max(0, 100 - o.w_pct);
    if (v === 'top') o.y_pct = 0;
    else if (v === 'middle') o.y_pct = Math.max(0, (100 - o.h_pct) / 2);
    else if (v === 'bottom') o.y_pct = Math.max(0, 100 - o.h_pct);
    overrideOverlays[idx] = o;
    dirty = true;
  }

  // Mesure le bloc texte rendu et ajuste w_pct/h_pct pour epouser le contenu
  function fitContent(ov: Overlay) {
    ensureOverride();
    if (!frameEl || !overrideOverlays) return;
    const box = frameEl.querySelector(`.overlay-box[data-id="${ov.id}"]`) as HTMLDivElement | null;
    if (!box) return;
    const inner = box.querySelector('.ov-text-multi, .ov-text') as HTMLElement | null;
    if (!inner) return;
    const frameRect = frameEl.getBoundingClientRect();
    // Hauteur reelle du texte + padding box
    const innerRect = inner.getBoundingClientRect();
    const padX = (ov.padding_x_px ?? 0) * 2;
    const padY = (ov.padding_y_px ?? 0) * 2;
    const targetH = ((innerRect.height + padY) / frameRect.height) * 100;
    const targetW = Math.min(100 - ov.x_pct, ((innerRect.width + padX) / frameRect.width) * 100);
    const idx = overrideOverlays.findIndex((o) => o.id === ov.id);
    if (idx < 0) return;
    overrideOverlays[idx] = { ...overrideOverlays[idx], h_pct: Math.max(5, Math.min(95, targetH)), w_pct: Math.max(10, Math.min(100 - ov.x_pct, targetW + 2)) };
    dirty = true;
  }

  function addText() {
    ensureOverride();
    const id = `text_${Date.now()}`;
    if (!overrideOverlays) overrideOverlays = [];
    overrideOverlays.push({
      id,
      type: 'text',
      text: 'Nouveau texte',
      x_pct: 25,
      y_pct: 40,
      w_pct: 50,
      h_pct: 12,
      start_t: 0,
      end_t: comp.duration_s ?? 40,
      color: '#fff',
      font_size_px: 28,
      bg_color: 'rgba(0,0,0,0.4)'
    });
    selectedId = id;
    dirty = true;
  }

  function addImage() {
    pickAssetAndAddOverlay('image');
  }

  function addVideo() {
    pickAssetAndAddOverlay('video');
  }

  // Ouvre le file picker natif et cree un Overlay (image ou video) avec data URL.
  function pickAssetAndAddOverlay(kind: 'image' | 'video') {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = kind === 'video'
      ? 'video/mp4,video/webm,video/quicktime'
      : 'image/png,image/svg+xml,image/jpeg,image/webp';
    input.style.display = 'none';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        if (typeof result !== 'string') return;
        ensureOverride();
        const id = `${kind}_${Date.now()}`;
        if (!overrideOverlays) overrideOverlays = [];
        // Unshift = derriere (z-order back) sur le frame, et en HAUT de la stack timeline
        overrideOverlays.unshift({
          id,
          type: kind,
          ...(kind === 'image' ? { image_url: result } : { video_url: result }),
          label: file.name,
          x_pct: 30,
          y_pct: 30,
          w_pct: 40,
          h_pct: 40,
          start_t: 0,
          end_t: comp.duration_s ?? 40,
          bg_color: 'transparent'
        });
        selectedId = id;
        dirty = true;
      };
      reader.readAsDataURL(file);
    };
    document.body.appendChild(input);
    input.click();
    setTimeout(() => document.body.removeChild(input), 1000);
  }

  function handleImageUpload(ev: Event, ov: Overlay) {
    const input = ev.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === 'string') {
        ensureOverride();
        if (overrideOverlays) {
          const idx = overrideOverlays.findIndex((o) => o.id === ov.id);
          if (idx >= 0) {
            overrideOverlays[idx] = { ...overrideOverlays[idx], image_url: result };
            dirty = true;
          }
        }
      }
    };
    reader.readAsDataURL(file);
  }

  // ---- Audio + Music volume ----
  let audioVolumeOverride = $state<number | null>(null);
  const audioVolume = $derived(audioVolumeOverride ?? comp?.audio_volume ?? 1);
  function setAudioVolume(v: number) {
    audioVolumeOverride = v;
    if (videoEl) videoEl.volume = v;
    dirty = true;
  }
  $effect(() => {
    if (videoEl && audioVolume != null) videoEl.volume = audioVolume;
  });

  let musicVolumeOverride = $state<number | null>(null);
  const musicVolume = $derived(musicVolumeOverride ?? comp?.music_track?.volume ?? 0.5);
  function setMusicVolume(v: number) {
    musicVolumeOverride = v;
    dirty = true;
  }

  function fmtT(t: number): string {
    return t.toFixed(1) + 's';
  }

  // Convert hex/named color + opacity (0..1) -> rgba CSS string.
  function withOpacity(color: string | undefined, opacity: number | undefined): string {
    const op = opacity == null ? 1 : Math.max(0, Math.min(1, opacity));
    if (!color || color === 'transparent') return 'transparent';
    // hex #RRGGBB ou #RGB
    const m6 = /^#([0-9a-f]{6})$/i.exec(color);
    const m3 = /^#([0-9a-f]{3})$/i.exec(color);
    if (m6) {
      const r = parseInt(m6[1].slice(0, 2), 16);
      const g = parseInt(m6[1].slice(2, 4), 16);
      const b = parseInt(m6[1].slice(4, 6), 16);
      return `rgba(${r},${g},${b},${op})`;
    }
    if (m3) {
      const r = parseInt(m3[1][0] + m3[1][0], 16);
      const g = parseInt(m3[1][1] + m3[1][1], 16);
      const b = parseInt(m3[1][2] + m3[1][2], 16);
      return `rgba(${r},${g},${b},${op})`;
    }
    // rgba(r,g,b,a) -> remplace a par op
    const mRgba = /^rgba?\(([^,]+),([^,]+),([^,]+)(?:,[^)]+)?\)$/i.exec(color);
    if (mRgba) {
      return `rgba(${mRgba[1].trim()},${mRgba[2].trim()},${mRgba[3].trim()},${op})`;
    }
    return color;
  }

  // ---- Timeline (clip drag horizontal) ----
  const totalDur = $derived(comp?.duration_s ?? 40);
  let timelineEl: HTMLDivElement | null = $state(null);
  let clipDrag: { id: string; startX: number; startStart: number; startEnd: number; mode: 'move' | 'resize-l' | 'resize-r'; mayToggle?: boolean; moved?: boolean } | null = null;

  function pctToSec(pct: number): number {
    return Math.max(0, Math.min(totalDur, (pct / 100) * totalDur));
  }

  function secToPct(t: number): number {
    return Math.max(0, Math.min(100, (t / totalDur) * 100));
  }

  function startClipDrag(e: PointerEvent, ov: Overlay, mode: 'move' | 'resize-l' | 'resize-r') {
    if (!timelineEl) return;
    e.preventDefault();
    e.stopPropagation();
    ensureOverride();
    // Toggle si on clique sur un clip deja selectionne (en mode move only, pour permettre resize sans deselect)
    if (mode === 'move' && selectedId === ov.id) {
      // Marquer pour potentielle deselection au pointerup (si pas de drag detecte)
      clipDrag = { id: ov.id, startX: e.clientX, startStart: ov.start_t, startEnd: ov.end_t, mode, mayToggle: true };
    } else {
      selectedId = ov.id;
      clipDrag = { id: ov.id, startX: e.clientX, startStart: ov.start_t, startEnd: ov.end_t, mode };
    }
    window.addEventListener('pointermove', onClipDrag);
    window.addEventListener('pointerup', endClipDrag, { once: true });
  }

  function onClipDrag(e: PointerEvent) {
    if (!clipDrag || !timelineEl || !overrideOverlays) return;
    const rect = timelineEl.getBoundingClientRect();
    const dt = ((e.clientX - clipDrag.startX) / rect.width) * totalDur;
    // Si on a bouge de + de 3px, on annule la possible toggle
    if (Math.abs(e.clientX - clipDrag.startX) > 3) {
      clipDrag.moved = true;
      clipDrag.mayToggle = false;
      // Si c'etait un clic toggle, s'assurer que l'item est selectionne pour le drag
      if (selectedId !== clipDrag.id) selectedId = clipDrag.id;
    }
    const idx = overrideOverlays.findIndex((o) => o.id === clipDrag!.id);
    if (idx < 0) return;
    const ov = overrideOverlays[idx];
    const len = clipDrag.startEnd - clipDrag.startStart;
    if (clipDrag.mode === 'move') {
      const newStart = Math.max(0, Math.min(totalDur - len, clipDrag.startStart + dt));
      ov.start_t = newStart;
      ov.end_t = newStart + len;
    } else if (clipDrag.mode === 'resize-l') {
      ov.start_t = Math.max(0, Math.min(clipDrag.startEnd - 0.5, clipDrag.startStart + dt));
    } else {
      ov.end_t = Math.max(clipDrag.startStart + 0.5, Math.min(totalDur, clipDrag.startEnd + dt));
    }
    overrideOverlays[idx] = { ...ov };
    dirty = true;
  }

  function endClipDrag() {
    window.removeEventListener('pointermove', onClipDrag);
    // Si on a juste click sans bouger (mayToggle reste vrai) -> deselect
    if (clipDrag?.mayToggle && !clipDrag.moved) {
      selectedId = null;
    }
    clipDrag = null;
  }

  // ---- SAM2 region drag (move + resize-l + resize-r) ----
  let sam2Drag: { id: string; startX: number; startStart: number; startEnd: number; mode: 'move' | 'resize-l' | 'resize-r'; moved?: boolean } | null = null;

  function startSam2Drag(e: PointerEvent, region: Sam2Region, mode: 'move' | 'resize-l' | 'resize-r') {
    if (!timelineEl) return;
    e.preventDefault();
    e.stopPropagation();
    sam2Drag = { id: region.id, startX: e.clientX, startStart: region.start_t, startEnd: region.end_t, mode };
    window.addEventListener('pointermove', onSam2Drag);
    window.addEventListener('pointerup', endSam2Drag, { once: true });
  }

  function onSam2Drag(e: PointerEvent) {
    if (!sam2Drag || !timelineEl) return;
    const rect = timelineEl.getBoundingClientRect();
    const dt = ((e.clientX - sam2Drag.startX) / rect.width) * totalDur;
    if (Math.abs(e.clientX - sam2Drag.startX) > 3) sam2Drag.moved = true;
    const idx = sam2Regions.findIndex((r) => r.id === sam2Drag!.id);
    if (idx < 0) return;
    const r = { ...sam2Regions[idx] };
    const len = sam2Drag.startEnd - sam2Drag.startStart;
    if (sam2Drag.mode === 'move') {
      const newStart = Math.max(0, Math.min(totalDur - len, sam2Drag.startStart + dt));
      r.start_t = newStart;
      r.end_t = newStart + len;
    } else if (sam2Drag.mode === 'resize-l') {
      r.start_t = Math.max(0, Math.min(sam2Drag.startEnd - 0.5, sam2Drag.startStart + dt));
    } else {
      r.end_t = Math.max(sam2Drag.startStart + 0.5, Math.min(totalDur, sam2Drag.startEnd + dt));
    }
    sam2Regions[idx] = r;
    dirty = true;
  }

  function endSam2Drag() {
    window.removeEventListener('pointermove', onSam2Drag);
    // Click sans drag = selectionne la region pour afficher ses proprietes dans le panel
    if (sam2Drag && !sam2Drag.moved) {
      selectSam2(sam2Drag.id);
    }
    sam2Drag = null;
  }

  // Scrub : pointerdown + drag + pointerup. Met a jour le master ET tous les overlays sync via $effect.
  let scrubbing = $state(false);
  function seekTo(e: PointerEvent) {
    if (!timelineEl || !videoEl) return;
    if ((e.target as HTMLElement).closest('.clip')) return; // ignore clicks sur clip
    e.preventDefault();
    const rect = timelineEl.getBoundingClientRect();
    const updateTo = (clientX: number) => {
      const pct = Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100));
      const t = pctToSec(pct);
      currentTime = t;
      // videoEl ne contient qu'UN rush -> seek en temps LOCAL du rush actif a t
      // (et non le temps global, qui depasserait la duree du fichier). Le switch de rush
      // (src) est gere par le $effect masterSrc ; ici on cale juste la frame locale.
      const r = rushes.find((rr) => t >= rr.start_t && t <= rr.end_t);
      if (videoEl) {
        const local = r ? (r.src_in ?? 0) + (t - r.start_t) : t;
        if (Math.abs(videoEl.currentTime - local) > 0.04) {
          try { videoEl.currentTime = local; } catch { /* */ }
        }
      }
    };
    updateTo(e.clientX);
    scrubbing = true;
    if (videoEl && !videoEl.paused) videoEl.pause();      // pause master pendant scrub
    const onMove = (ev: PointerEvent) => updateTo(ev.clientX);
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      scrubbing = false;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  function clearSelectionOnEmptyClick(e: MouseEvent) {
    // Click sur empty track-body (ni clip ni ruler-tick) -> deselect
    const t = e.target as HTMLElement;
    if (t.closest('.clip') || t.closest('.ruler-body')) return;
    if (t.classList.contains('track-body')) selectedId = null;
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape' && selectedId) {
      e.preventDefault();
      selectedId = null;
    }
  }

  $effect(() => {
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  // Time ruler ticks — adaptatif selon zoom
  const tickPositions = $derived.by(() => {
    const ticks: { t: number; pct: number }[] = [];
    const step = zoom >= 4 ? 1 : zoom >= 2 ? 2 : 5;
    for (let t = 0; t <= totalDur; t += step) ticks.push({ t, pct: secToPct(t) });
    return ticks;
  });

  // ---- Timeline zoom + toggles (activable on/off) ----
  let zoom = $state(1);                            // 1x = fit, 2x/4x/8x = zoom
  let showFrames = $state(true);                   // toolbar toggle : rushes/thumbnails
  let showWaveform = $state(true);                 // toolbar toggle : waveforms
  let showSync = $state(true);                     // toolbar toggle : points sync V/A
  let showMusic = $state(true);                    // toolbar toggle : canal bande son
  // Track-level enabled (checkbox a droite du label) : juste grayscale, contenu reste affiche
  let videoTrackEnabled = $state(true);
  // Expand toggle par track id (track 'video', 'audio', 'music', overlay.id, sam2.id)
  let expandedTracks = $state<Record<string, boolean>>({});
  function toggleExpand(id: string) {
    expandedTracks = { ...expandedTracks, [id]: !expandedTracks[id] };
    dirty = true;                              // editor preference change
  }

  // Largeur de la colonne sticky (label) : resizable manuel + auto-fit
  let stickyColWidth = $state(180);

  // Drag handle pour resize manuel
  function startColResize(e: PointerEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = stickyColWidth;
    const onMove = (ev: PointerEvent) => {
      const next = Math.max(90, Math.min(420, startW + (ev.clientX - startX)));
      stickyColWidth = next;
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      dirty = true;            // resize fini = preference change
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  // Auto-fit : mesure le plus long label visible + actions, fixe width
  function autoFitStickyColAndDirty() { autoFitStickyCol(); dirty = true; }
  function autoFitStickyCol() {
    const labels = document.querySelectorAll('.track-label .track-name');
    if (!labels.length) return;
    const probe = document.createElement('span');
    Object.assign(probe.style, {
      visibility: 'hidden',
      position: 'absolute',
      whiteSpace: 'nowrap',
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--text-micro)',
    });
    document.body.appendChild(probe);
    let maxW = 0;
    for (const lbl of labels) {
      probe.textContent = lbl.textContent ?? '';
      maxW = Math.max(maxW, probe.getBoundingClientRect().width);
    }
    document.body.removeChild(probe);
    // total = chev(18) + type(28) + maxW(name) + gap(16) + check(16) + del(28) + padding(16)
    stickyColWidth = Math.max(90, Math.min(420, Math.ceil(maxW + 120)));
  }
  let audioTrackEnabled = $state(true);
  let musicTrackEnabled = $state(true);            // si false -> row disparait

  // Override rushes (editable) : si null -> reflete comp.rushes, sinon prend la copie editee
  let rushesOverride = $state<Rush[] | null>(null);
  const rushes = $derived<Rush[]>(rushesOverride ?? comp?.rushes ?? []);

  // Active rush at currentTime (concatenation : le rush dont [start_t, end_t] contient currentTime)
  const activeRush = $derived<Rush | null>(rushes.find((r) => currentTime >= r.start_t && currentTime <= r.end_t) ?? null);

  // Source du master video sur le frame :
  //  - Si rushes ont un video_url => utilise le rush actif (auto-switch au seek)
  //  - Sinon fallback sur comp.video_url legacy (single file)
  const masterSrc = $derived<string>(
    activeRush?.video_url ?? rushes.find((r) => r.video_url)?.video_url ?? comp?.video_url ?? ''
  );

  // Sync : quand le rush actif change, seek le video element au temps local de ce rush
  let lastMasterSrc = '';
  let playing = $state(false);
  $effect(() => {
    if (!videoEl || !activeRush) return;
    const srcIn = activeRush.src_in ?? 0;
    const localT = srcIn + (currentTime - activeRush.start_t);
    // Si on a switche de rush (src change), attendre loadedmetadata pour seek
    if (videoEl.src && lastMasterSrc !== masterSrc) {
      lastMasterSrc = masterSrc;
      const wasPlaying = playing;
      const onMeta = () => {
        try { videoEl!.currentTime = Math.max(0, Math.min(videoEl!.duration ?? localT, localT)); } catch { /* */ }
        // Lecture continue du montage : on reprend le play sur le rush suivant
        if (wasPlaying) { videoEl!.play().catch(() => { /* */ }); }
        videoEl!.removeEventListener('loadedmetadata', onMeta);
      };
      videoEl.addEventListener('loadedmetadata', onMeta);
    } else if (Math.abs(videoEl.currentTime - localT) > 0.1) {
      try { videoEl.currentTime = Math.max(0, localT); } catch { /* */ }
    }
  });

  function ensureRushesOverride() {
    if (rushesOverride === null) {
      rushesOverride = JSON.parse(JSON.stringify(comp?.rushes ?? []));
    }
  }

  // Re-layout : recompute start_t/end_t sequentiel apres add/delete/reorder/trim
  function reLayoutRushes() {
    if (!rushesOverride) return;
    let t = 0;
    for (const r of rushesOverride) {
      const len = Math.max(0.1, (r.src_out ?? r.duration_s ?? r.end_t - r.start_t) - (r.src_in ?? 0));
      r.start_t = t;
      r.end_t = t + len;
      t = r.end_t;
    }
  }
  function addRush() {
    // Ouvre file picker -> creer rush avec video_url + duree auto
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'video/mp4,video/webm,video/quicktime';
    input.style.display = 'none';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      // Lit duration via element video temporaire (data URL conserve fichier en memoire)
      const dataUrl: string = await new Promise((res) => {
        const r = new FileReader();
        r.onload = () => res(r.result as string);
        r.readAsDataURL(file);
      });
      const dur: number = await new Promise((res) => {
        const v = document.createElement('video');
        v.preload = 'metadata';
        v.muted = true;
        v.onloadedmetadata = () => res(v.duration);
        v.onerror = () => res(2);
        v.src = dataUrl;
        setTimeout(() => res(2), 4000);
      });
      ensureRushesOverride();
      if (!rushesOverride) return;
      const palette = ['#FF5B14', '#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#9aa5b1'];
      const colorIdx = rushesOverride.length % palette.length;
      rushesOverride.push({
        start_t: 0, end_t: 0,         // recompute via reLayoutRushes
        video_url: dataUrl,
        duration_s: dur,
        src_in: 0,
        src_out: dur,
        label: file.name,
        color: palette[colorIdx]
      });
      reLayoutRushes();
      dirty = true;
    };
    document.body.appendChild(input);
    input.click();
    setTimeout(() => document.body.removeChild(input), 1000);
  }
  function deleteRush(idx: number) {
    ensureRushesOverride();
    if (!rushesOverride) return;
    rushesOverride = rushesOverride.filter((_, i) => i !== idx);
    reLayoutRushes();
    dirty = true;
  }
  function splitRushAtCurrent(idx: number) {
    ensureRushesOverride();
    if (!rushesOverride || idx < 0 || idx >= rushesOverride.length) return;
    const r = rushesOverride[idx];
    if (currentTime <= r.start_t || currentTime >= r.end_t) return;
    // Position locale dans le source = src_in + (currentTime - start_t)
    const splitSrc = (r.src_in ?? 0) + (currentTime - r.start_t);
    const left = { ...r, src_out: splitSrc };
    const right = { ...r, src_in: splitSrc, label: (r.label ?? 'Rush') + ' (b)' };
    const arr = [...rushesOverride];
    arr.splice(idx, 1, left, right);
    rushesOverride = arr;
    reLayoutRushes();
    dirty = true;
  }

  // Drag rush edges (move / resize-l / resize-r)
  let rushDrag: { idx: number; startX: number; startStart: number; startEnd: number; mode: 'move' | 'resize-l' | 'resize-r' } | null = null;
  function startRushDrag(e: PointerEvent, idx: number, mode: 'move' | 'resize-l' | 'resize-r') {
    const target = e.target as HTMLElement;
    if (target.closest('.rush-action')) return;     // laisser action buttons cliquer
    e.preventDefault();
    e.stopPropagation();
    ensureRushesOverride();
    if (!rushesOverride) return;
    const r = rushesOverride[idx];
    // En mode trim, on garde la src_in/src_out de depart pour le delta
    rushDrag = { idx, startX: e.clientX, startStart: r.src_in ?? 0, startEnd: r.src_out ?? (r.duration_s ?? r.end_t - r.start_t), mode };
    window.addEventListener('pointermove', onRushDrag);
    window.addEventListener('pointerup', endRushDrag, { once: true });
  }
  function onRushDrag(e: PointerEvent) {
    if (!rushDrag || !timelineEl || !rushesOverride) return;
    const rect = timelineEl.getBoundingClientRect();
    const dt = ((e.clientX - rushDrag.startX) / rect.width) * totalDur;
    const r = { ...rushesOverride[rushDrag.idx] };
    const srcDur = r.duration_s ?? (rushDrag.startEnd - rushDrag.startStart);

    if (rushDrag.mode === 'move') {
      // Reorder : detecte le rush sous le pointeur, swap si different
      const target = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const targetMarker = target?.closest('.rush-marker.editable') as HTMLElement | null;
      if (targetMarker) {
        const allMarkers = Array.from(timelineEl.querySelectorAll('.rush-marker.editable'));
        const targetIdx = allMarkers.indexOf(targetMarker);
        if (targetIdx !== -1 && targetIdx !== rushDrag.idx) {
          // Swap rushDrag.idx <-> targetIdx
          const arr = [...rushesOverride];
          const [moved] = arr.splice(rushDrag.idx, 1);
          arr.splice(targetIdx, 0, moved);
          rushesOverride = arr;
          rushDrag.idx = targetIdx;
          reLayoutRushes();
        }
      }
      dirty = true;
      return;
    }

    // Trim : modifie src_in / src_out (le start_t/end_t suivent via reLayoutRushes)
    const curSrcIn = r.src_in ?? 0;
    const curSrcOut = r.src_out ?? srcDur;
    if (rushDrag.mode === 'resize-l') {
      // resize-l : delta sur src_in (par rapport au start du drag)
      const newSrcIn = Math.max(0, Math.min(curSrcOut - 0.2, rushDrag.startStart + dt));
      r.src_in = newSrcIn;
    } else {
      // resize-r : delta sur src_out (par rapport au start du drag)
      const newSrcOut = Math.max((r.src_in ?? 0) + 0.2, Math.min(srcDur, rushDrag.startEnd + dt));
      r.src_out = newSrcOut;
    }
    rushesOverride[rushDrag.idx] = r;
    reLayoutRushes();
    dirty = true;
  }
  function endRushDrag() {
    window.removeEventListener('pointermove', onRushDrag);
    rushDrag = null;
  }
  const syncPoints = $derived<SyncPoint[]>(comp?.audio_sync_points ?? []);
  const music = $derived<MusicClip | undefined>(comp?.music_track);

  // Real waveform extraction via Web Audio API
  let realAudioWaveform = $state<number[] | null>(null);
  let realMusicWaveform = $state<number[] | null>(null);
  let waveformLoading = $state(false);

  const waveform = $derived<number[]>(realAudioWaveform ?? comp?.audio_waveform ?? []);
  const musicWaveform = $derived<number[]>(realMusicWaveform ?? comp?.music_track?.waveform ?? []);

  async function extractWaveform(url: string, bins = 200): Promise<number[]> {
    try {
      const res = await fetch(url);
      if (!res.ok) return [];
      const buf = await res.arrayBuffer();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const AC: typeof AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext;
      const ctx = new AC();
      const audioBuf = await ctx.decodeAudioData(buf);
      const channelData = audioBuf.getChannelData(0);
      const samplesPerBin = Math.max(1, Math.floor(channelData.length / bins));
      const result: number[] = [];
      for (let i = 0; i < bins; i++) {
        let max = 0;
        const start = i * samplesPerBin;
        const end = Math.min(start + samplesPerBin, channelData.length);
        for (let j = start; j < end; j++) {
          const v = Math.abs(channelData[j]);
          if (v > max) max = v;
        }
        result.push(max);
      }
      await ctx.close();
      // Normalisation pour l'AFFICHAGE : on cale le pic a 1.0 pour que la waveform reste
      // visible quel que soit le niveau absolu (une bande son lo-fi a -20dB sinon = barres
      // de ~6px, invisibles). On ne touche pas a l'audio, juste a la visu.
      const peak = result.reduce((m, v) => (v > m ? v : m), 0);
      if (peak > 0 && peak < 0.95) {
        const g = Math.min(1 / peak, 12); // cap le gain pour ne pas exploser le bruit de fond
        for (let i = 0; i < result.length; i++) result[i] = Math.min(1, result[i] * g);
      }
      return result;
    } catch (e) {
      console.warn('[waveform] extraction failed:', e);
      return [];
    }
  }

  let lastVideoUrl = '';
  let lastMusicUrl = '';

  // ---- UI : sections collapsibles props panel ----
  let openSections = $state({
    layout: true,
    typo: true,
    fill: false,
    effects: false,
    time: false,
    sam2: true,                      // SAM2 incrustation option ouverte par defaut
  });
  function toggleSection(k: keyof typeof openSections) { openSections[k] = !openSections[k]; }

  $effect(() => {
    const vUrl = comp?.video_url;
    if (vUrl && vUrl !== lastVideoUrl) {
      lastVideoUrl = vUrl;
      waveformLoading = true;
      extractWaveform(vUrl, 200).then((w) => {
        if (w.length > 0) realAudioWaveform = w;
        waveformLoading = false;
      });
    }
  });

  $effect(() => {
    const mUrl = comp?.music_track?.url;
    if (mUrl && mUrl !== lastMusicUrl) {
      lastMusicUrl = mUrl;
      extractWaveform(mUrl, 200).then((w) => {
        if (w.length > 0) realMusicWaveform = w;
      });
    }
  });

  // ============================================================
  // SAM2 screen replacement (recipe `incrust-iphone-screen-replacement`)
  // - kind = 'image' (PNG/JPG) ou 'video' (MP4/WEBM)
  // - regions[] visualisees sur la timeline (track ⌖ SAM2)
  // ============================================================
  // Video layer = incrustation video/image dans la video principale.
  // - Par defaut : overlay simple (positionne x/y/w/h sur le frame), pas de pipeline.
  // - Option : sam2_enabled = true -> tracking SAM2 + remplace l ecran trackeable.
  // - Filters : feather_px (mask softness), opacity, blend.
  interface Sam2Region {
    id: string;
    enabled?: boolean;                // toggle visibility (default = true)
    label?: string;                   // nom editable affiche dans le sticky label timeline
    // SAM2 tracking visualization (rempli par backend pour preview)
    bbox_preview?: [number, number, number, number];   // [x, y, w, h] en pixel coords source
    bbox_label?: string;              // label detecte (ex: "cell phone 87%")
    start_t: number;
    end_t: number;
    // Asset : data URL inline (upload) OU URL statique (persistance DB)
    ui_data_url: string;
    ui_url?: string;
    ui_kind: 'image' | 'video';
    ui_name: string;
    poster_url?: string;
    // Overlay position (used when sam2_enabled = false)
    x_pct: number;
    y_pct: number;
    w_pct: number;
    h_pct: number;
    // Filters (apply in both modes)
    opacity: number;                 // 0..1
    feather_px: number;              // 0..30, edge smoothing
    // SAM2 (option, off by default). 3 modes pour seed le tracking :
    //  - point != null         => mode manual (pixel coords)
    //  - text_prompt != null   => mode "Decris" via YOLO-World
    //  - aucun des deux        => mode YOLO auto (COCO classes)
    sam2_enabled: boolean;
    point: [number, number] | null;
    text_prompt?: string;
    status: 'idle' | 'running' | 'done' | 'error';
    progress?: { step: string; percent: number; eta_s: number };
    output_url?: string;
    error?: string;
  }

  // sam2Regions[] est un legacy data shape (avant unification). On le migre en overlays au mount.
  let sam2Regions = $state<Sam2Region[]>([]);                    // gardee transitoire (rendu desactive)
  let sam2RegionsInitFromComp = false;

  // Migration : comp.sam2Regions[] -> overlays type='video' avec sam2 config (unifie en 1 seul track type)
  $effect(() => {
    if (sam2RegionsInitFromComp) return;
    if (!comp) return;
    sam2RegionsInitFromComp = true;

    // Auto-create 1 rush par defaut depuis comp.video_url si pas de rushes definis (legacy single video)
    const existingRushes = comp.rushes ?? [];
    const hasRealRushes = existingRushes.some((r) => !!r.video_url);
    if (!hasRealRushes && comp.video_url) {
      const dur = comp.duration_s ?? 8;
      rushesOverride = [{
        start_t: 0,
        end_t: dur,
        video_url: comp.video_url,
        duration_s: dur,
        label: comp.video_url.split('/').pop() ?? 'Master',
        color: '#FF5B14'
      }];
    }

    // Restaure tout le UI state persiste : track enables, volumes, editor preferences
    const c = comp as unknown as {
      video_track_enabled?: boolean; audio_track_enabled?: boolean; music_track_enabled?: boolean;
      audio_volume?: number; music_volume?: number;
      editor_state?: { expanded_tracks?: Record<string, boolean>; sticky_col_width?: number; zoom?: number; show_frames?: boolean; show_waveform?: boolean; show_sync?: boolean; show_music?: boolean };
    };
    if (typeof c.video_track_enabled === 'boolean') videoTrackEnabled = c.video_track_enabled;
    if (typeof c.audio_track_enabled === 'boolean') audioTrackEnabled = c.audio_track_enabled;
    if (typeof c.music_track_enabled === 'boolean') musicTrackEnabled = c.music_track_enabled;
    if (typeof c.audio_volume === 'number') audioVolumeOverride = c.audio_volume;
    if (typeof c.music_volume === 'number') musicVolumeOverride = c.music_volume;
    const es = c.editor_state;
    if (es) {
      if (es.expanded_tracks) expandedTracks = es.expanded_tracks;
      if (typeof es.sticky_col_width === 'number') stickyColWidth = es.sticky_col_width;
      if (typeof es.zoom === 'number') zoom = es.zoom;
      if (typeof es.show_frames === 'boolean') showFrames = es.show_frames;
      if (typeof es.show_waveform === 'boolean') showWaveform = es.show_waveform;
      if (typeof es.show_sync === 'boolean') showSync = es.show_sync;
      if (typeof es.show_music === 'boolean') showMusic = es.show_music;
    }
    const legacy = comp.sam2Regions;
    if (!legacy || legacy.length === 0) return;
    ensureOverride();
    if (!overrideOverlays) overrideOverlays = [];
    for (const r of legacy) {
      // Si deja migre (memo en overlay.id), skip
      if (overrideOverlays.some((o) => o.id === r.id)) continue;
      overrideOverlays.push({
        id: r.id,
        type: 'video',
        label: r.label ?? r.ui_name,
        enabled: r.enabled,
        image_url: r.ui_kind === 'image' ? (r.ui_url || r.ui_data_url) : undefined,
        video_url: r.ui_kind === 'video' ? (r.ui_url || r.ui_data_url) : undefined,
        x_pct: r.x_pct ?? 30,
        y_pct: r.y_pct ?? 30,
        w_pct: r.w_pct ?? 40,
        h_pct: r.h_pct ?? 40,
        start_t: r.start_t,
        end_t: r.end_t,
        bg_color: 'transparent',
        sam2: r.sam2_enabled ? {
          enabled: true,
          mode: r.text_prompt ? 'text' : (r.point ? 'point' : 'yolo'),
          point: r.point ?? null,
          text_prompt: r.text_prompt,
          feather_px: r.feather_px,
          opacity: r.opacity,
          status: r.status === 'running' ? 'idle' : r.status,   // re-init du running au reload
          output_url: r.output_url,
          error: r.error,
        } : undefined,
      });
    }
    // On vide la liste legacy pour eviter le double rendu
    sam2Regions = [];
    dirty = true;
  });
  let sam2PickRegionId = $state<string | null>(null);   // id de la region en cours de pick (null = off)
  let sam2PollInterval: ReturnType<typeof setInterval> | null = null;
  let sam2RunningId = $state<string | null>(null);
  let selectedSam2Id = $state<string | null>(null);     // region selectionnee (panel proprietes)

  function selectSam2(id: string | null) {
    selectedSam2Id = id;
    if (id) selectedId = null;                            // mutual exclusion overlay vs sam2
  }

  // Auto-trigger SAM2 pipeline : des qu une region a sam2_enabled + asset + change de seed,
  // declenche un run debounce 800ms. Pas de bouton "Run" manuel.
  const autoTriggerTimers = new Map<string, ReturnType<typeof setTimeout>>();
  function scheduleAutoRun(r: Sam2Region) {
    if (!r.sam2_enabled || !assetSrc(r) || !comp?.video_url) return;
    if (r.status === 'running') return;
    // Debounce per region : evite de spammer si user change rapidement les filtres
    const existing = autoTriggerTimers.get(r.id);
    if (existing) clearTimeout(existing);
    autoTriggerTimers.set(r.id, setTimeout(() => {
      runSam2(r.id);
      autoTriggerTimers.delete(r.id);
    }, 800));
  }

  // Watch overlay.sam2 changes -> auto-schedule pipeline.
  // (Modele unifie : SAM2 = option sur Overlay, plus sur Sam2Region.)
  const lastSignature = new Map<string, string>();
  $effect(() => {
    for (const ov of overlays) {
      if (!ov.sam2?.enabled) continue;
      const ovSrc = ov.video_url || ov.image_url || '';
      if (!ovSrc) continue;
      const sig = `${ov.sam2.enabled}|${ovSrc}|${ov.sam2.point?.join(',') ?? ''}|${ov.sam2.text_prompt ?? ''}|${ov.sam2.feather_px ?? ''}|${ov.sam2.opacity ?? ''}`;
      const prev = lastSignature.get(ov.id);
      if (prev === sig) continue;
      lastSignature.set(ov.id, sig);
      const isInitialMount = prev === undefined;
      // Ne pas re-run au mount si deja done/error (use cached output_url)
      if (isInitialMount && (ov.sam2.status === 'done' || ov.sam2.status === 'error')) continue;
      // Stale 'running' au mount (process tue entre sessions) -> reset a idle pour permettre re-run
      if (isInitialMount && ov.sam2.status === 'running') {
        ensureOverride();
        const i = overrideOverlays?.findIndex((o) => o.id === ov.id) ?? -1;
        if (i >= 0 && overrideOverlays) {
          overrideOverlays[i] = { ...overrideOverlays[i], sam2: { ...overrideOverlays[i].sam2!, status: 'idle' } };
        }
        continue;
      }
      if (ov.sam2.status === 'running') continue;
      scheduleAutoRunForOverlay(ov);
    }
  });

  const autoTriggerOvTimers = new Map<string, ReturnType<typeof setTimeout>>();
  function scheduleAutoRunForOverlay(ov: Overlay) {
    if (!comp?.video_url && !rushes.find((r) => r.video_url)) return;
    const existing = autoTriggerOvTimers.get(ov.id);
    if (existing) clearTimeout(existing);
    autoTriggerOvTimers.set(ov.id, setTimeout(() => {
      runSam2ForOverlay(ov.id);
      autoTriggerOvTimers.delete(ov.id);
    }, 800));
  }

  async function runSam2ForOverlay(ovId: string) {
    ensureOverride();
    if (!overrideOverlays) return;
    const idx = overrideOverlays.findIndex((o) => o.id === ovId);
    if (idx < 0) return;
    const ov = overrideOverlays[idx];
    if (!ov.sam2 || !ov.sam2.enabled) return;
    const ovSrc = ov.video_url || ov.image_url || '';
    const videoSrc = rushes.find((r) => r.video_url)?.video_url ?? comp?.video_url;
    if (!ovSrc || !videoSrc) {
      ov.sam2 = { ...ov.sam2, status: 'error', error: 'video source + asset required' };
      overrideOverlays[idx] = { ...ov };
      return;
    }
    ov.sam2 = { ...ov.sam2, status: 'running', progress: { step: 'starting', percent: 0, eta_s: 0 }, error: undefined };
    overrideOverlays[idx] = { ...ov };
    sam2RunningId = ovId;

    // Persiste 'running' en DB immediatement pour eviter re-declenchement sur reload
    const _stid = (metadata?.step_trace_id ?? metadata?.stepTraceId ?? metadata?.id) as number | undefined;
    if (_stid) {
      fetch(`/api/comps/${_stid}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ patches: [{ path: ['overlays', String(idx), 'sam2', 'status'], value: 'running' }] })
      }).catch(() => {});
    }

    try {
      const res = await fetch('/api/sam2/screen-replace', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          video_url: videoSrc,
          ui_data_url: ovSrc.startsWith('data:') ? ovSrc : undefined,
          ui_url: !ovSrc.startsWith('data:') ? ovSrc : undefined,
          ui_kind: ov.type === 'video' ? 'video' : 'image',
          click_point: ov.sam2.point,
          text_prompt: ov.sam2.text_prompt,
          feather_px: ov.sam2.feather_px,
          opacity: ov.sam2.opacity
        })
      });
      const json = await res.json();
      if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);
      const outputUrl = json.output_url as string;
      sam2PollInterval = setInterval(async () => {
        try {
          const pr = await fetch('/api/sam2/progress').then((r) => r.json());
          if (!overrideOverlays) { stopSam2Polling(); return; }
          const i = overrideOverlays.findIndex((o) => o.id === ovId);
          if (i < 0) { stopSam2Polling(); return; }
          const o = overrideOverlays[i];
          if (o.sam2 && typeof pr?.percent === 'number') {
            o.sam2 = { ...o.sam2, progress: { step: pr.step ?? '...', percent: pr.percent, eta_s: pr.eta_s ?? 0 } };
            overrideOverlays[i] = { ...o };
          }
          if (pr?.status === 'done' || pr?.percent >= 100) {
            stopSam2Polling();
            sam2RunningId = null;
            if (o.sam2) {
              o.sam2 = { ...o.sam2, status: 'done', output_url: outputUrl };
              overrideOverlays[i] = { ...o };
              // Persiste 'done' + output_url en DB pour survivre aux reloads
              if (_stid) {
                fetch(`/api/comps/${_stid}`, {
                  method: 'PATCH',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ patches: [
                    { path: ['overlays', String(i), 'sam2', 'status'], value: 'done' },
                    { path: ['overlays', String(i), 'sam2', 'output_url'], value: outputUrl }
                  ]})
                }).catch(() => {});
              }
            }
          }
        } catch { /* ignore transient */ }
      }, 1500);
    } catch (err) {
      stopSam2Polling();
      sam2RunningId = null;
      const i = overrideOverlays.findIndex((o) => o.id === ovId);
      if (i >= 0) {
        const o = overrideOverlays[i];
        if (o.sam2) {
          o.sam2 = { ...o.sam2, status: 'error', error: err instanceof Error ? err.message : String(err) };
          overrideOverlays[i] = { ...o };
        }
      }
    }
  }

  // ---- 2-step delete confirmation ----
  let armedDeleteId = $state<string | null>(null);
  let armedDeleteTimer: ReturnType<typeof setTimeout> | null = null;

  function armDelete(id: string) {
    armedDeleteId = id;
    if (armedDeleteTimer) clearTimeout(armedDeleteTimer);
    armedDeleteTimer = setTimeout(() => { armedDeleteId = null; }, 4000);
  }
  function confirmDeleteOverlay(id: string) {
    if (armedDeleteId === id) {
      deleteOverlay(id);
      armedDeleteId = null;
      if (armedDeleteTimer) clearTimeout(armedDeleteTimer);
    } else {
      armDelete(id);
    }
  }
  function confirmDeleteSam2(id: string) {
    if (armedDeleteId === id) {
      deleteSam2Region(id);
      if (selectedSam2Id === id) selectedSam2Id = null;
      armedDeleteId = null;
      if (armedDeleteTimer) clearTimeout(armedDeleteTimer);
    } else {
      armDelete(id);
    }
  }

  // helper : ajoute une nouvelle video incrustation (placeholder, sans asset)
  // Resoud la source de l asset (uploaded data URL > URL statique persistee)
  function assetSrc(r: Sam2Region): string {
    return r.ui_data_url || r.ui_url || '';
  }

  function addSam2Track() {
    const dur = comp.duration_s ?? videoEl?.duration ?? 10;
    const region: Sam2Region = {
      id: 'video-' + Math.random().toString(36).slice(2, 8),
      start_t: 0,
      end_t: dur,
      ui_data_url: '',
      ui_kind: 'image',
      ui_name: '',
      x_pct: 30,
      y_pct: 30,
      w_pct: 40,
      h_pct: 40,
      opacity: 1,
      feather_px: 4,
      sam2_enabled: false,
      point: null,
      status: 'idle'
    };
    sam2Regions = [...sam2Regions, region];
    dirty = true;
  }

  function onFrameClickForSam2(e: PointerEvent) {
    if (!sam2PickRegionId || !frameEl || !videoEl) return;
    const rect = frameEl.getBoundingClientRect();
    const xPct = (e.clientX - rect.left) / rect.width;
    const yPct = (e.clientY - rect.top) / rect.height;
    const vw = videoEl.videoWidth || rect.width;
    const vh = videoEl.videoHeight || rect.height;
    const point: [number, number] = [Math.round(xPct * vw), Math.round(yPct * vh)];

    // Cherche d abord dans overlays (modele unifie), fallback sam2Regions[] (legacy)
    ensureOverride();
    if (overrideOverlays) {
      const idx = overrideOverlays.findIndex((o) => o.id === sam2PickRegionId);
      if (idx >= 0) {
        const ov = overrideOverlays[idx];
        ov.sam2 = { ...(ov.sam2 ?? { enabled: true }), point, mode: 'point' };
        overrideOverlays[idx] = { ...ov };
        dirty = true;
        sam2PickRegionId = null;
        return;
      }
    }
    // Legacy sam2Regions fallback
    updateRegion(sam2PickRegionId, { point });
    sam2PickRegionId = null;
  }

  async function onSam2UiFileForRegion(e: Event, regionId: string) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const kind: 'image' | 'video' = file.type.startsWith('video/') ? 'video' : 'image';
    const dataUrl: string = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.readAsDataURL(file);
    });
    const poster = kind === 'image' ? dataUrl : (await generateVideoPoster(dataUrl)) ?? undefined;
    updateRegion(regionId, { ui_data_url: dataUrl, ui_kind: kind, ui_name: file.name, poster_url: poster });
    dirty = true;
  }

  // Genere une vignette JPEG data: URL depuis frame 1 d une video file.
  async function generateVideoPoster(dataUrl: string): Promise<string | null> {
    return new Promise((resolve) => {
      const v = document.createElement('video');
      v.muted = true;
      v.src = dataUrl;
      v.crossOrigin = 'anonymous';
      v.preload = 'metadata';
      v.onloadeddata = () => {
        try {
          v.currentTime = 0.01;
        } catch { /* ignore */ }
      };
      v.onseeked = () => {
        try {
          const c = document.createElement('canvas');
          c.width = Math.min(240, v.videoWidth || 240);
          c.height = Math.round(c.width * (v.videoHeight / v.videoWidth || 0.5625));
          const ctx = c.getContext('2d');
          if (!ctx) return resolve(null);
          ctx.drawImage(v, 0, 0, c.width, c.height);
          resolve(c.toDataURL('image/jpeg', 0.7));
        } catch {
          resolve(null);
        }
      };
      v.onerror = () => resolve(null);
      setTimeout(() => resolve(null), 5000);
    });
  }

  function stopSam2Polling() {
    if (sam2PollInterval) { clearInterval(sam2PollInterval); sam2PollInterval = null; }
  }

  function updateRegion(id: string, patch: Partial<Sam2Region>) {
    const idx = sam2Regions.findIndex((r) => r.id === id);
    if (idx < 0) return;
    sam2Regions[idx] = { ...sam2Regions[idx], ...patch };
  }

  async function runSam2(regionId: string) {
    const region = sam2Regions.find((r) => r.id === regionId);
    if (!region) return;
    const asset = assetSrc(region);
    if (!comp?.video_url || !asset) {
      updateRegion(regionId, { status: 'error', error: 'video source + asset required' });
      return;
    }
    updateRegion(regionId, { status: 'running', progress: { step: 'starting', percent: 0, eta_s: 0 }, error: undefined });
    sam2RunningId = regionId;

    try {
      const res = await fetch('/api/sam2/screen-replace', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          video_url: comp.video_url,
          ui_data_url: region.ui_data_url || undefined,
          ui_url: region.ui_url || undefined,
          ui_kind: region.ui_kind,
          click_point: region.point,
          text_prompt: region.text_prompt || undefined,
          feather_px: region.feather_px,
          opacity: region.opacity
        })
      });
      const json = await res.json();
      if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);
      const outputUrl = json.output_url as string;
      sam2PollInterval = setInterval(async () => {
        try {
          const pr = await fetch('/api/sam2/progress').then((r) => r.json());
          if (pr && typeof pr.percent === 'number') {
            updateRegion(regionId, { progress: { step: pr.step ?? '...', percent: pr.percent, eta_s: pr.eta_s ?? 0 } });
          }
          if (pr?.status === 'done' || pr?.percent >= 100) {
            stopSam2Polling();
            sam2RunningId = null;
            updateRegion(regionId, { status: 'done', output_url: outputUrl });
          }
        } catch { /* ignore transient */ }
      }, 1500);
    } catch (err) {
      stopSam2Polling();
      sam2RunningId = null;
      updateRegion(regionId, { status: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  }

  function applySam2Region(id: string) {
    const r = sam2Regions.find((x) => x.id === id);
    if (!r?.output_url) return;
    if (videoEl) {
      videoEl.src = r.output_url;
      videoEl.load();
    }
    dirty = true;
  }

  function deleteSam2Region(id: string) {
    sam2Regions = sam2Regions.filter((r) => r.id !== id);
    if (sam2RunningId === id) { stopSam2Polling(); sam2RunningId = null; }
    dirty = true;
  }

  // Last region status helpers (used by panel summary line)
  const lastSam2 = $derived(sam2Regions[sam2Regions.length - 1] ?? null);

  // ============================================================
  // RichText : migration legacy + helpers d affichage
  // ============================================================
  function legacyToRichText(ov: Overlay): RichText {
    // Si rich_text deja present : retour direct.
    if (ov.rich_text && ov.rich_text.spans?.length) return ov.rich_text;
    // Si text_lines : un span par ligne avec leur styles, jointed par \n
    if (ov.text_lines && ov.text_lines.length > 0) {
      const spans = ov.text_lines.flatMap((line, i) => {
        const span = {
          text: line.text,
          style: {
            ...(line.color || ov.color ? { color: line.color ?? ov.color } : {}),
            ...(line.font_size_px || ov.font_size_px ? { font_size_px: line.font_size_px ?? ov.font_size_px } : {}),
            ...(line.font_weight || ov.font_weight ? { font_weight: (line.font_weight ?? ov.font_weight) as 400 | 700 } : {}),
            ...(line.font_family || ov.font_family ? { font_family: line.font_family ?? ov.font_family } : {}),
          }
        };
        return i < ov.text_lines!.length - 1 ? [span, { text: '\n' }] : [span];
      });
      return { spans, block_align: ov.text_align, line_height: ov.line_height };
    }
    // Single text legacy
    return fromString(ov.text ?? '', {
      ...(ov.color ? { color: ov.color } : {}),
      ...(ov.font_size_px ? { font_size_px: ov.font_size_px } : {}),
      ...(ov.font_weight ? { font_weight: ov.font_weight as 400 | 700 } : {}),
      ...(ov.font_family ? { font_family: ov.font_family } : {}),
    });
  }

  // Calcule le RichText a afficher pour un overlay, en tenant compte de typing_animation.
  // Vitesse = char_count / (end_t - start_t) — auto, pas d arg manuel.
  // toHtml emet des font-size:Npx INLINE par span (px canvas 1080). Dans la preview
  // (frameW px), il faut les scaler comme le reste -> sinon le texte deborde sa boite.
  function scaleRichText(rt: RichText, factor: number): RichText {
    if (!rt?.spans || !factor || factor === 1) return rt;
    return {
      ...rt,
      spans: rt.spans.map((s) => {
        if (!s.style) return s;
        const st = { ...s.style };
        if (typeof st.font_size_px === 'number') st.font_size_px = st.font_size_px * factor;
        if (typeof st.letter_spacing_px === 'number') st.letter_spacing_px = st.letter_spacing_px * factor;
        return { ...s, style: st };
      }),
    };
  }

  function richTextForOverlay(ov: Overlay, t: number): RichText {
    const base = legacyToRichText(ov);
    if (!ov.typing_animation) return base;
    const total = charCount(base);
    if (total === 0) return base;
    const dur = Math.max(0.01, ov.end_t - ov.start_t);
    const elapsed = Math.max(0, t - ov.start_t);
    const ratio = Math.min(1, elapsed / dur);
    const n = Math.floor(total * ratio);
    return sliceChars(base, n);
  }

</script>

<div class="comp-editor">
  <div class="toolbar">
    <button type="button" class="btn-add" onclick={addText}>+ Texte</button>
    <button type="button" class="btn-add" onclick={addImage}>+ Image</button>
    <button type="button" class="btn-add" onclick={addVideo} title="Ajouter une video en overlay (file picker)">+ Video</button>
    <span class="toolbar-sep"></span>
    <span class="info">{visibleOverlays.length}/{overlays.length} overlays visibles · t={fmtT(currentTime)}</span>
    <span class="toolbar-spacer"></span>
    {#if saveMsg}<span class="save-msg" class:err={saveMsg.includes('fail') || saveMsg.includes('error')}>{saveMsg}</span>{/if}
    <div class="versions-wrap">
      <button type="button" class="btn-add" onclick={() => { versionsOpen = !versionsOpen; if (versionsOpen) loadVersions(); }} title="Voir les versions sauvegardees">⎌ Versions {versions.length > 0 ? `(${versions.length})` : ''}</button>
      {#if versionsOpen}
        <div class="versions-menu">
          <div class="versions-head">
            <span>Historique</span>
            <button type="button" class="hero-btn" onclick={() => (versionsOpen = false)}>×</button>
          </div>
          {#if versionsLoading}
            <span class="sam2-meta dim">Chargement...</span>
          {:else if versions.length === 0}
            <span class="sam2-meta dim">Aucune version. La 1re sauve creera la 1re entree.</span>
          {:else}
            <ul class="versions-list">
              {#each versions as v (v.idx)}
                <li>
                  <span class="sam2-meta">#{v.idx} · {new Date(v.ts).toLocaleString('fr-FR', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })} {v.label ? '· ' + v.label : ''}</span>
                  <button type="button" class="sam2-btn small" onclick={() => restoreVersion(v.idx)}>Restaurer</button>
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      {/if}
    </div>
    <button type="button" class="btn-save" onclick={save} disabled={!dirty || saving}>
      {saving ? 'Saving...' : (dirty ? 'Save' : 'Saved')}
    </button>
  </div>

  <div class="editor-row">
    <div class="frame-wrap" class:vertical={aspectRatio === '9:16' || aspectRatio === '4:5'}>
      <div class="frame" class:pick-mode={sam2PickRegionId !== null} bind:this={frameEl} bind:clientWidth={frameW} style:aspect-ratio={AR_CSS[aspectRatio] ?? '9 / 16'} onpointerdown={(e) => {
        if (sam2PickRegionId) { onFrameClickForSam2(e); return; }
        if ((e.target as HTMLElement).classList.contains('frame')) selectedId = null;
      }} role="presentation">
        {#if masterSrc}
          <!-- svelte-ignore a11y_media_has_caption -->
          <video
            bind:this={videoEl}
            class="video-bg"
            src={masterSrc}
            ontimeupdate={onTimeUpdate}
            onloadedmetadata={onVideoMeta}
            onplay={() => (playing = true)}
            onpause={() => (playing = false)}
            controls
            playsinline
          ></video>
        {:else}
          <div class="no-video">Aucune video</div>
        {/if}

        {#each visibleOverlays as ov (ov.id)}
          <div
            class="overlay-box"
            class:selected={selectedId === ov.id}
            class:ov-glass={ov.liquid_glass}
            data-id={ov.id}
            style:left={ov.x_pct + '%'}
            style:top={ov.y_pct + '%'}
            style:width={ov.w_pct + '%'}
            style:height={ov.h_pct + '%'}
            style:background={ov.liquid_glass ? undefined : withOpacity(ov.bg_color, ov.bg_opacity)}
            style:border-radius={(ov.border_radius_px ?? 0) + 'px'}
            style:border-style={(ov.border_width_px ?? 0) > 0 ? 'solid' : 'none'}
            style:border-color={ov.border_color ?? 'transparent'}
            style:border-width={(ov.border_width_px ?? 0) + 'px'}
            style:padding-left={(ov.padding_x_px ?? 0) + 'px'}
            style:padding-right={(ov.padding_x_px ?? 0) + 'px'}
            style:padding-top={(ov.padding_y_px ?? 0) + 'px'}
            style:padding-bottom={(ov.padding_y_px ?? 0) + 'px'}
            onpointerdown={(e) => startDrag(e, ov, 'move')}
            role="button"
            tabindex="0"
          >
            {#if ov.type === 'text'}
              {@const rt = richTextForOverlay(ov, currentTime)}
              <div
                class="ov-rich"
                style:color={ov.color ?? '#fff'}
                style:font-family={ov.font_family ?? 'inherit'}
                style:font-size={((ov.font_size_px ?? 24) * (frameW > 0 ? frameW / CANVAS_W : 0.5)) + 'px'}
                style:font-weight={ov.font_weight ?? 600}
                style:text-align={rt.block_align ?? ov.text_align ?? 'center'}
                style:letter-spacing={(ov.letter_spacing_px ?? 0) + 'px'}
                style:line-height={rt.line_height ?? ov.line_height ?? 1.15}
                style:opacity={ov.text_opacity ?? 1}
              >
                <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                {@html toHtml(scaleRichText(rt, frameW > 0 ? frameW / CANVAS_W : 0.5))}
                {#if ov.typing_animation && currentTime >= ov.start_t && currentTime <= ov.end_t}
                  <span class="caret-blink" aria-hidden="true">|</span>
                {/if}
              </div>
            {:else if ov.type === 'image' && ov.image_url}
              <img src={ov.image_url} alt={ov.label ?? ''} class="ov-img" />
            {:else if ov.type === 'video' && ov.video_url}
              <!-- svelte-ignore a11y_media_has_caption -->
              <!-- Pas d autoplay/loop : sync sur currentTime du master via $effect plus bas -->
              <video bind:this={overlayVideoEls[ov.id]} src={ov.video_url} muted playsinline preload="auto" class="ov-img"></video>
            {/if}
            {#if selectedId === ov.id}
              <span
                class="resize-handle"
                onpointerdown={(e) => startDrag(e, ov, 'resize')}
                role="button"
                tabindex="0"
                aria-label="resize"
              ></span>
            {/if}
          </div>
        {/each}

        <!-- Video incrustations : visibles sur le frame quand SAM2 OFF (sinon le pipeline backend remplace l ecran) -->
        {#each sam2Regions as r (r.id)}
          {#if r.enabled !== false && assetSrc(r) && !r.sam2_enabled && currentTime >= r.start_t && currentTime <= r.end_t}
            <div
              class="video-overlay"
              style:left={r.x_pct + '%'}
              style:top={r.y_pct + '%'}
              style:width={r.w_pct + '%'}
              style:height={r.h_pct + '%'}
              style:opacity={r.opacity}
              style:--feather={r.feather_px + 'px'}
            >
              {#if r.ui_kind === 'video'}
                <!-- svelte-ignore a11y_media_has_caption -->
                <video src={assetSrc(r)} autoplay loop muted playsinline class="ov-video"></video>
              {:else}
                <img src={assetSrc(r)} alt={r.ui_name} class="ov-video" />
              {/if}
            </div>
          {/if}
        {/each}

        <!-- SAM2 tracking visualization : overlay HTML positionne en % (taille crosshair = pixels ecran) -->
        {#if videoMeta && videoMeta.w > 0}
          {@const vw = videoMeta.w}
          {@const vh = videoMeta.h}
          <!-- NEW : iterate overlays unified (modele unifie) -->
          {#each overlays as ov (ov.id)}
            {#if ov.enabled !== false && ov.sam2?.enabled && currentTime >= ov.start_t && currentTime <= ov.end_t}
              {#if ov.sam2.point}
                <div class="sam2-seed" style:left={(ov.sam2.point[0] / vw * 100) + '%'} style:top={(ov.sam2.point[1] / vh * 100) + '%'} aria-hidden="true">
                  <div class="sam2-seed-ring"></div>
                  <div class="sam2-seed-cross-h"></div>
                  <div class="sam2-seed-cross-v"></div>
                  <span class="sam2-seed-label">{ov.label || 'tracked'}</span>
                </div>
              {/if}
            {/if}
          {/each}
          <!-- LEGACY : sam2Regions[] (vide apres migration, garde pour back-compat) -->
          {#each sam2Regions as r (r.id)}
            {#if r.enabled !== false && r.sam2_enabled && currentTime >= r.start_t && currentTime <= r.end_t}
              {#if r.point}
                <div class="sam2-seed" style:left={(r.point[0] / vw * 100) + '%'} style:top={(r.point[1] / vh * 100) + '%'} aria-hidden="true">
                  <div class="sam2-seed-ring"></div>
                  <div class="sam2-seed-cross-h"></div>
                  <div class="sam2-seed-cross-v"></div>
                  <span class="sam2-seed-label">{r.ui_name || 'tracked'}</span>
                </div>
              {/if}
              {#if r.bbox_preview && r.bbox_preview.length === 4}
                <div class="sam2-bbox"
                  style:left={(r.bbox_preview[0] / vw * 100) + '%'}
                  style:top={(r.bbox_preview[1] / vh * 100) + '%'}
                  style:width={(r.bbox_preview[2] / vw * 100) + '%'}
                  style:height={(r.bbox_preview[3] / vh * 100) + '%'}
                  aria-hidden="true"
                >
                  <span class="sam2-bbox-label">{r.bbox_label ?? r.text_prompt ?? 'detected'}</span>
                </div>
              {/if}
            {/if}
          {/each}
        {/if}
      </div>
    </div>

    <aside class="props-panel">
      {#if !selectedId && !selectedSam2Id}
        <div class="panel-hint">
          <span class="sam2-meta dim">Click sur un track de la timeline pour editer ses proprietes.</span>
        </div>
      {/if}

      <!-- ============================================================
           PANEL : SAM2 region selectionnee (incrustation video / image)
           ============================================================ -->
      {#if selectedSam2Id}
        {@const r = sam2Regions.find((x) => x.id === selectedSam2Id)}
        {#if r}
          <div class="sam2-region selected-region" class:err={r.status === 'error'}>
            <div class="sam2-region-row">
              <span class="sam2-pill kind">{r.ui_kind}</span>
              <span class="sam2-meta" title={r.ui_name || 'sans asset'}>{r.ui_name || 'aucun asset'}</span>
              {#if r.sam2_enabled}
                <span class="sam2-status" data-status={r.status} title={r.error ?? ''}>
                  {r.status === 'done' ? '✓' : r.status === 'error' ? '✕' : r.status === 'running' ? '…' : '○'}
                </span>
              {/if}
              <button type="button" class="sam2-x" onclick={() => { deleteSam2Region(r.id); selectedSam2Id = null; }} aria-label="delete" title="Supprimer">×</button>
            </div>

            <div class="sam2-region-row filters">
              <label class="micro-field" title="Opacite (0-100%)">
                <span class="ph-icon">◐</span>
                <input type="number" min="0" max="100" step="5"
                  value={Math.round(r.opacity * 100)}
                  oninput={(e) => updateRegion(r.id, { opacity: Math.max(0, Math.min(1, +(e.currentTarget as HTMLInputElement).value / 100)) })} />
              </label>
              <label class="micro-field" title="Edge feather / smoothing (px)">
                <span class="ph-icon">∿</span>
                <input type="number" min="0" max="30" step="1"
                  value={r.feather_px}
                  oninput={(e) => updateRegion(r.id, { feather_px: Math.max(0, Math.min(30, +(e.currentTarget as HTMLInputElement).value)) })} />
              </label>
            </div>

            <div class="sam2-region-row sam2-toggle-row">
              <label class="sam2-check">
                <input type="checkbox" checked={r.sam2_enabled} onchange={(e) => updateRegion(r.id, { sam2_enabled: (e.currentTarget as HTMLInputElement).checked })} />
                <span>⌖ SAM2 tracking</span>
              </label>
              {#if r.sam2_enabled}
                <span class="sam2-status inline" data-status={r.status} title={r.error ?? ''}>
                  {r.status === 'done' ? '✓ ready' : r.status === 'error' ? '✕ ' + (r.error ?? 'error') : r.status === 'running' ? `… ${r.progress?.percent ?? 0}%` : '○ queued'}
                </span>
              {/if}
            </div>
            {#if r.sam2_enabled}
              <!-- Mode tracking : Manual / YOLO / Text (auto-resolu cote backend, pas de Run manuel) -->
              <div class="sam2-region-row sam2-mode-row">
                <label class="sam2-mode" class:active={!r.point && !r.text_prompt}>
                  <input type="radio" name={`mode-${r.id}`} checked={!r.point && !r.text_prompt} onchange={() => updateRegion(r.id, { point: null, text_prompt: undefined })} />
                  <span>YOLO</span>
                </label>
                <label class="sam2-mode" class:active={!!r.point}>
                  <input type="radio" name={`mode-${r.id}`} checked={!!r.point} onchange={() => { sam2PickRegionId = r.id; }} />
                  <span>Point</span>
                </label>
                <label class="sam2-mode" class:active={!!r.text_prompt}>
                  <input type="radio" name={`mode-${r.id}`} checked={!!r.text_prompt} onchange={() => updateRegion(r.id, { text_prompt: r.text_prompt ?? 'the screen', point: null })} />
                  <span>Décris</span>
                </label>
              </div>
              {#if r.text_prompt !== undefined}
                <div class="sam2-region-row">
                  <input type="text" class="sam2-text-input" placeholder="ex: l ecran du laptop"
                    value={r.text_prompt}
                    oninput={(e) => updateRegion(r.id, { text_prompt: (e.currentTarget as HTMLInputElement).value })}
                  />
                </div>
              {/if}
              {#if r.point}
                <div class="sam2-region-row">
                  <span class="sam2-meta dim">point pixel: <strong>{r.point[0]}, {r.point[1]}</strong></span>
                  <button type="button" class="sam2-btn small" onclick={() => updateRegion(r.id, { point: null })} title="Reset point">×</button>
                </div>
              {/if}
              {#if r.status === 'running' && r.progress}
                <div class="sam2-bar"><div class="sam2-fill" style:width={r.progress.percent + '%'}></div></div>
              {/if}
            {/if}
          </div>
        {/if}
      {/if}

      {#if selectedId}
        {@const sel = overlays.find((o) => o.id === selectedId)}
        {#if sel}
          <div class="prop-edit-v2">
            {#if sel.type === 'text'}
              <!-- Editeur de texte stylise unique : remplace ancien text + text_lines + per-line styles -->
              {#key selectedId}
              <RichTextEditor
                displayScale={frameW > 0 ? frameW / CANVAS_W : 0.4}
                value={legacyToRichText(sel)}
                onchange={(rt) => {
                  sel.rich_text = rt;
                  // Une fois migre, on ignore les legacy fields
                  sel.text = undefined;
                  sel.text_lines = undefined;
                  dirty = true;
                }}
              />
              {/key}
              <!-- Toggle typing animation : vitesse auto = char_count / (end_t - start_t) -->
              <label class="typing-toggle" title="Effet typewriter : chars reveles progressivement sur la duree du clip">
                <input type="checkbox" checked={!!sel.typing_animation} onchange={(e) => { sel.typing_animation = (e.currentTarget as HTMLInputElement).checked; dirty = true; }} />
                <span>⌨ Typing</span>
                {#if sel.typing_animation}
                  <span class="typing-rate">{(charCount(legacyToRichText(sel)) / Math.max(0.01, sel.end_t - sel.start_t)).toFixed(1)} char/s</span>
                {/if}
              </label>
            {/if}

            {#if sel.type === 'image'}
              <label class="hero-input">
                <input type="text" value={sel.image_url ?? ''} placeholder="URL image" oninput={(e) => { sel.image_url = (e.currentTarget as HTMLInputElement).value; dirty = true; }} />
                <label class="hero-btn" title="Upload file" style="cursor:pointer;">
                  ⬆
                  <input type="file" accept="image/png,image/svg+xml,image/jpeg,image/webp" style="display:none" onchange={(e) => handleImageUpload(e, sel)} />
                </label>
              </label>
              {#if sel.image_url}
                <div class="img-preview"><img src={sel.image_url} alt="" /></div>
              {/if}
            {/if}

            <!-- SECTION : LAYOUT (position, alignement, fit) -->
            <div class="acc-section" class:open={openSections.layout}>
              <button type="button" class="acc-header" onclick={() => toggleSection('layout')}>
                <span class="acc-chev">{openSections.layout ? '▾' : '▸'}</span>
                <span class="acc-title">⊟ Layout</span>
              </button>
              {#if openSections.layout}
                <div class="acc-body">
                  <div class="ctrl-row">
                    <label class="micro-field" title="X%"><span class="ph-icon">X</span><input type="number" value={Math.round(sel.x_pct * 10) / 10} min="0" max="100" step="1" oninput={(e) => { sel.x_pct = +(e.currentTarget as HTMLInputElement).value; dirty = true; }} /></label>
                    <label class="micro-field" title="Y%"><span class="ph-icon">Y</span><input type="number" value={Math.round(sel.y_pct * 10) / 10} min="0" max="100" step="1" oninput={(e) => { sel.y_pct = +(e.currentTarget as HTMLInputElement).value; dirty = true; }} /></label>
                  </div>
                  <div class="ctrl-row">
                    <label class="micro-field" title="W%"><span class="ph-icon">W</span><input type="number" value={Math.round(sel.w_pct * 10) / 10} min="5" max="100" step="1" oninput={(e) => { sel.w_pct = +(e.currentTarget as HTMLInputElement).value; dirty = true; }} /></label>
                    <label class="micro-field" title="H%"><span class="ph-icon">H</span><input type="number" value={Math.round(sel.h_pct * 10) / 10} min="5" max="100" step="1" oninput={(e) => { sel.h_pct = +(e.currentTarget as HTMLInputElement).value; dirty = true; }} /></label>
                  </div>
                  <div class="align-grid-compact">
                    <button type="button" class="align-cell" title="↖" onclick={() => alignOverlay(sel, 'left', 'top')}>↖</button>
                    <button type="button" class="align-cell" title="↑" onclick={() => alignOverlay(sel, 'center', 'top')}>↑</button>
                    <button type="button" class="align-cell" title="↗" onclick={() => alignOverlay(sel, 'right', 'top')}>↗</button>
                    <button type="button" class="align-cell" title="←" onclick={() => alignOverlay(sel, 'left', 'middle')}>←</button>
                    <button type="button" class="align-cell center" title="●" onclick={() => alignOverlay(sel, 'center', 'middle')}>●</button>
                    <button type="button" class="align-cell" title="→" onclick={() => alignOverlay(sel, 'right', 'middle')}>→</button>
                    <button type="button" class="align-cell" title="↙" onclick={() => alignOverlay(sel, 'left', 'bottom')}>↙</button>
                    <button type="button" class="align-cell" title="↓" onclick={() => alignOverlay(sel, 'center', 'bottom')}>↓</button>
                    <button type="button" class="align-cell" title="↘" onclick={() => alignOverlay(sel, 'right', 'bottom')}>↘</button>
                  </div>
                  <button type="button" class="full-btn" onclick={() => fitContent(sel)} title="Fit content">⤢ Fit content</button>
                </div>
              {/if}
            </div>

            {#if sel.type === 'text'}
              <!-- TYPOGRAPHY accordion supprimee : RichTextEditor (en haut) gere deja font/size/weight/color/align/spacing -->

              <!-- SECTION : FILL (bg color + presets + opacity) -->
              <div class="acc-section" class:open={openSections.fill}>
                <button type="button" class="acc-header" onclick={() => toggleSection('fill')}>
                  <span class="acc-chev">{openSections.fill ? '▾' : '▸'}</span>
                  <span class="acc-title">▣ Fill / Pill</span>
                </button>
                {#if openSections.fill}
                  <div class="acc-body">
                    <div class="ctrl-row">
                      <label class="swatch-field full" title="Couleur fond">
                        <span class="swatch-box" style:background={sel.bg_color ?? 'transparent'}></span>
                        <input type="text" placeholder="transparent" value={sel.bg_color ?? ''} oninput={(e) => { sel.bg_color = (e.currentTarget as HTMLInputElement).value || undefined; dirty = true; }} />
                      </label>
                      <label class="micro-field" title="Opacite fond"><span class="ph-icon">◐</span><input type="number" min="0" max="100" step="5" value={Math.round((sel.bg_opacity ?? 1) * 100)} oninput={(e) => { sel.bg_opacity = +(e.currentTarget as HTMLInputElement).value / 100; dirty = true; }} /></label>
                    </div>
                    <div class="bg-presets">
                      <button type="button" class="bg-pst" onclick={() => { sel.bg_color = 'transparent'; dirty = true; }}>none</button>
                      <button type="button" class="bg-pst orange" onclick={() => { sel.bg_color = '#FF5B14'; dirty = true; }}>orange</button>
                      <button type="button" class="bg-pst dim" onclick={() => { sel.bg_color = 'rgba(0,0,0,0.4)'; dirty = true; }}>dim</button>
                      <button type="button" class="bg-pst dark" onclick={() => { sel.bg_color = 'rgba(0,0,0,0.7)'; dirty = true; }}>dark</button>
                    </div>
                    <label class="glass-toggle" title="Rendu Apple liquid glass (carte/pill en verre)">
                      <input type="checkbox" checked={!!sel.liquid_glass} onchange={(e) => { sel.liquid_glass = (e.currentTarget as HTMLInputElement).checked; dirty = true; }} />
                      <span>◇ Liquid glass</span>
                    </label>
                    <!-- Radius + presets -->
                    <div class="ctrl-row">
                      <label class="micro-field" title="Forme (radius px)"><span class="ph-icon">⌐</span><input type="number" min="0" max="100" step="1" bind:value={sel.border_radius_px} placeholder="0" oninput={() => (dirty = true)} /></label>
                      <div class="shape-presets">
                        <button type="button" class="icon-btn" title="square" onclick={() => { sel.border_radius_px = 0; dirty = true; }}>□</button>
                        <button type="button" class="icon-btn" title="rounded" onclick={() => { sel.border_radius_px = 8; dirty = true; }}>▢</button>
                        <button type="button" class="icon-btn" title="pill" onclick={() => { sel.border_radius_px = 100; dirty = true; }}>⬭</button>
                      </div>
                    </div>
                    <!-- Border -->
                    <div class="ctrl-row">
                      <label class="swatch-field" title="Couleur ligne">
                        <input type="color" value={sel.border_color ?? '#ffffff'} oninput={(e) => { sel.border_color = (e.currentTarget as HTMLInputElement).value; dirty = true; }} />
                        <span class="swatch-hex">{sel.border_color ?? '#fff'}</span>
                      </label>
                      <label class="micro-field" title="Epaisseur ligne (px)"><span class="ph-icon">▭</span><input type="number" min="0" max="10" step="1" bind:value={sel.border_width_px} placeholder="0" oninput={() => (dirty = true)} /></label>
                    </div>
                    <!-- Padding -->
                    <div class="ctrl-row">
                      <label class="micro-field" title="Padding H (px)"><span class="ph-icon">⫾</span><input type="number" min="0" max="40" step="1" bind:value={sel.padding_x_px} placeholder="0" oninput={() => (dirty = true)} /></label>
                      <label class="micro-field" title="Padding V (px)"><span class="ph-icon">⩵</span><input type="number" min="0" max="40" step="1" bind:value={sel.padding_y_px} placeholder="0" oninput={() => (dirty = true)} /></label>
                    </div>
                  </div>
                {/if}
              </div>
            {/if}

            <!-- SECTION : TIME -->
            <div class="acc-section" class:open={openSections.time}>
              <button type="button" class="acc-header" onclick={() => toggleSection('time')}>
                <span class="acc-chev">{openSections.time ? '▾' : '▸'}</span>
                <span class="acc-title">⏱ Time</span>
              </button>
              {#if openSections.time}
                <div class="acc-body">
                  <div class="ctrl-row">
                    <label class="micro-field" title="Start (s)"><span class="ph-icon">▶</span><input type="number" bind:value={sel.start_t} min="0" step="0.1" oninput={() => (dirty = true)} /></label>
                    <label class="micro-field" title="End (s)"><span class="ph-icon">⏹</span><input type="number" bind:value={sel.end_t} min="0" step="0.1" oninput={() => (dirty = true)} /></label>
                  </div>
                </div>
              {/if}
            </div>

            <!-- SECTION : SAM2 INCRUSTATION (option pour TOUT overlay : texte / image / video) -->
            <div class="acc-section" class:open={openSections.sam2}>
              <button type="button" class="acc-header" onclick={() => toggleSection('sam2')}>
                <span class="acc-chev">{openSections.sam2 ? '▾' : '▸'}</span>
                <span class="acc-title">⌖ Incrustation SAM2</span>
                {#if sel.sam2?.enabled}
                  <span class="sam2-status inline" data-status={sel.sam2.status ?? 'idle'} title={sel.sam2.error ?? ''}>
                    {sel.sam2.status === 'done' ? '✓' : sel.sam2.status === 'error' ? `✕ ${sel.sam2.error ?? 'error'}` : sel.sam2.status === 'running' ? `… ${sel.sam2.progress?.percent ?? 0}%` : '○'}
                  </span>
                {/if}
              </button>
              {#if openSections.sam2}
                <div class="acc-body">
                  <label class="sam2-check">
                    <input type="checkbox" checked={!!sel.sam2?.enabled} onchange={(e) => { sel.sam2 = { ...(sel.sam2 ?? {}), enabled: (e.currentTarget as HTMLInputElement).checked }; dirty = true; }} />
                    <span>Activer le tracking</span>
                  </label>
                  {#if sel.sam2?.enabled}
                    <div class="ctrl-row sam2-mode-row" style="margin-top:6px;">
                      <label class="sam2-mode" class:active={!sel.sam2?.point && !sel.sam2?.text_prompt}>
                        <input type="radio" name={`mode-${sel.id}`} checked={!sel.sam2?.point && !sel.sam2?.text_prompt} onchange={() => { sel.sam2 = { ...sel.sam2!, point: null, text_prompt: undefined, mode: 'yolo' }; dirty = true; }} />
                        <span>YOLO auto</span>
                      </label>
                      <label class="sam2-mode" class:active={!!sel.sam2?.point || sam2PickRegionId === sel.id}>
                        <input type="radio" name={`mode-${sel.id}`} checked={!!sel.sam2?.point || sam2PickRegionId === sel.id} onchange={() => { sel.sam2 = { ...sel.sam2!, mode: 'point' }; sam2PickRegionId = sel.id; dirty = true; }} />
                        <span>{sam2PickRegionId === sel.id ? '… clique sur le frame' : 'Point'}</span>
                      </label>
                      <label class="sam2-mode" class:active={!!sel.sam2?.text_prompt}>
                        <input type="radio" name={`mode-${sel.id}`} checked={!!sel.sam2?.text_prompt} onchange={() => { sel.sam2 = { ...sel.sam2!, text_prompt: sel.sam2?.text_prompt ?? 'the screen', point: null, mode: 'text' }; dirty = true; }} />
                        <span>Décris</span>
                      </label>
                    </div>
                    {#if sel.sam2?.text_prompt !== undefined}
                      <input type="text" class="sam2-text-input" placeholder="ex: l ecran du laptop"
                        value={sel.sam2.text_prompt}
                        oninput={(e) => { sel.sam2 = { ...sel.sam2!, text_prompt: (e.currentTarget as HTMLInputElement).value }; dirty = true; }}
                      />
                    {/if}
                    <!-- Filtres edge feather + opacity -->
                    <div class="ctrl-row" style="margin-top:6px;">
                      <label class="micro-field" title="Opacite incrustation (0-100%)"><span class="ph-icon">◐</span>
                        <input type="number" min="0" max="100" step="5"
                          value={Math.round((sel.sam2.opacity ?? 1) * 100)}
                          oninput={(e) => { sel.sam2 = { ...sel.sam2!, opacity: Math.max(0, Math.min(1, +(e.currentTarget as HTMLInputElement).value / 100)) }; dirty = true; }} />
                      </label>
                      <label class="micro-field" title="Edge feather (px)"><span class="ph-icon">∿</span>
                        <input type="number" min="0" max="30" step="1"
                          value={sel.sam2.feather_px ?? 4}
                          oninput={(e) => { sel.sam2 = { ...sel.sam2!, feather_px: Math.max(0, Math.min(30, +(e.currentTarget as HTMLInputElement).value)) }; dirty = true; }} />
                      </label>
                    </div>
                    {#if sel.sam2?.status === 'running' && sel.sam2?.progress}
                      <div class="sam2-bar"><div class="sam2-fill" style:width={sel.sam2.progress.percent + '%'}></div></div>
                    {/if}
                  {/if}
                </div>
              {/if}
            </div>
          </div>
        {/if}
      {/if}
    </aside>
  </div>

  <!-- Timeline tracks -->
  <div class="timeline-panel" style:--sticky-col={stickyColWidth + 'px'}>
    <div class="timeline-header">
      <span class="tl-title">Timeline</span>
      <div class="tl-toggles">
        <button type="button" class="tg" class:on={showFrames} onclick={() => { showFrames = !showFrames; dirty = true; }} title="Rushes / thumbnails">🎞 Frames</button>
        <button type="button" class="tg" class:on={showWaveform} onclick={() => { showWaveform = !showWaveform; dirty = true; }} title="Waveform audio">〰 Waveform</button>
        <button type="button" class="tg" class:on={showSync} onclick={() => { showSync = !showSync; dirty = true; }} title="Points sync V/A">⤓ Sync</button>
        <button type="button" class="tg" class:on={showMusic} onclick={() => { showMusic = !showMusic; dirty = true; }} title="Canal bande son">🎵 Music</button>
      </div>
      <span class="tl-spacer"></span>
      <button type="button" class="tg" onclick={autoFitStickyColAndDirty} title="Ajuster auto la largeur de la colonne label">⇲ Auto-fit</button>
      <div class="zoom-ctrl">
        <button type="button" class="zoom-btn" onclick={() => { zoom = Math.max(1, zoom / 2); dirty = true; }} disabled={zoom <= 1}>−</button>
        <span class="zoom-val">{zoom}x</span>
        <button type="button" class="zoom-btn" onclick={() => { zoom = Math.min(16, zoom * 2); dirty = true; }} disabled={zoom >= 16}>+</button>
      </div>
      <span class="tl-time">{fmtT(currentTime)} / {fmtT(totalDur)}</span>
    </div>

    <div class="tracks-scroll">
      <!-- Drag handle pour resize de la colonne sticky : barre verticale invisible-but-active a x = stickyColWidth -->
      <div class="col-resizer" style:left={(stickyColWidth + 4) + 'px'} onpointerdown={startColResize} role="separator" aria-orientation="vertical" tabindex="0"></div>
      <div class="tracks" style:width={(zoom * 100) + '%'}>
      <!-- Time ruler -->
      <div class="track-row ruler-row">
        <span class="track-label sticky">⏱</span>
        <div class="track-body ruler-body" bind:this={timelineEl} onpointerdown={seekTo} role="slider" aria-label="seek" tabindex="0" aria-valuemin="0" aria-valuemax={totalDur} aria-valuenow={currentTime}>
          {#each tickPositions as tick}
            <span class="ruler-tick" style:left={tick.pct + '%'}>
              <span class="ruler-label">{tick.t}s</span>
            </span>
          {/each}
          {#if showSync}
            {#each syncPoints as sp}
              <span class="sync-marker" style:left={secToPct(sp.t) + '%'} title={sp.label ?? `sync @ ${fmtT(sp.t)}`}></span>
            {/each}
          {/if}
          <span class="playhead" style:left={secToPct(currentTime) + '%'}></span>
        </div>
      </div>

      <!-- Overlay tracks d'abord (en haut) -->
      {#each overlays as ov, ovIdx (ov.id)}
        <div class="track-row" class:disabled={ov.enabled === false} class:expanded={expandedTracks[ov.id]} class:reordering={reorderDrag?.id === ov.id}>
          <span class="track-label overlay sticky" title={ov.text ?? ov.id}>
            <span class="reorder-handle" data-overlay-id={ov.id} onpointerdown={(e) => startReorderDrag(e, ov.id)} title="Drag pour reordonner la stack verticale" role="presentation">⋮⋮</span>
            <button type="button" class="track-chev" onclick={() => toggleExpand(ov.id)} title={expandedTracks[ov.id] ? 'Reduire' : 'Agrandir'}>{expandedTracks[ov.id] ? '▾' : '▸'}</button>
            <span class="track-type">{ov.type === 'text' ? 'T' : ov.type === 'video' ? 'VID' : 'IMG'}</span>
            <input
              type="text"
              class="track-name track-name-input"
              value={ov.label ?? plainText(legacyToRichText(ov)) ?? ov.id}
              placeholder={ov.id}
              oninput={(e) => { ov.label = (e.currentTarget as HTMLInputElement).value; dirty = true; }}
            />
            <input
              type="checkbox"
              class="track-check"
              checked={ov.enabled !== false}
              onchange={(e) => toggleOverlayEnabled(ov.id, e)}
              title={ov.enabled === false ? 'Activer overlay' : 'Desactiver overlay'}
            />
            <button
              type="button"
              class="track-mini del"
              class:armed={armedDeleteId === ov.id}
              onclick={() => confirmDeleteOverlay(ov.id)}
              aria-label="delete overlay"
              title={armedDeleteId === ov.id ? 'Reclic pour confirmer' : 'Supprimer overlay'}
            >
              {#if armedDeleteId === ov.id}<span class="del-confirm">?</span>{:else}
                <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M2.5 4.5h11"/>
                  <path d="M6.5 4.5V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.5"/>
                  <path d="M4.5 4.5l.5 9a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1l.5-9"/>
                  <path d="M7 7v5"/>
                  <path d="M9 7v5"/>
                </svg>
              {/if}
            </button>
          </span>
          <div class="track-body">
            <div
              class="clip clip-overlay"
              class:selected={selectedId === ov.id}
              data-clip-color={['orange', 'blue', 'green', 'yellow', 'pink', 'cyan'][ovIdx % 6]}
              style:left={secToPct(ov.start_t) + '%'}
              style:width={secToPct(ov.end_t - ov.start_t) + '%'}
              onpointerdown={(e) => startClipDrag(e, ov, 'move')}
              role="button"
              tabindex="0"
            >
              <span
                class="clip-edge clip-edge-l"
                onpointerdown={(e) => startClipDrag(e, ov, 'resize-l')}
                role="button"
                tabindex="0"
                aria-label="trim start"
              ></span>
              <!-- Mini-frame : indique la position de l overlay sur la video principale -->
              <div class="pos-mini" style:aspect-ratio={AR_CSS[aspectRatio] ?? '9 / 16'} title={`Position : ${Math.round(ov.x_pct)}% × ${Math.round(ov.y_pct)}% · ${Math.round(ov.w_pct)}% × ${Math.round(ov.h_pct)}%`}>
                <div class="pos-mini-rect"
                  style:left={ov.x_pct + '%'}
                  style:top={ov.y_pct + '%'}
                  style:width={ov.w_pct + '%'}
                  style:height={ov.h_pct + '%'}
                ></div>
              </div>
              <!-- Preview du contenu de l overlay dans le clip body -->
              {#if ov.type === 'text'}
                <span class="clip-preview text" title={plainText(legacyToRichText(ov))}>
                  {plainText(legacyToRichText(ov)) || ov.label || ov.id}
                </span>
              {:else if ov.type === 'image' && ov.image_url}
                <img class="clip-preview-thumb" src={ov.image_url} alt={ov.label ?? ''} />
                <span class="clip-preview text">{ov.label ?? 'image'}</span>
              {:else if ov.type === 'video' && (ov.video_url || ov.image_url)}
                {@const src = ov.video_url || ov.image_url || ''}
                {@const isVideo = src.endsWith('.mp4') || src.endsWith('.webm') || src.endsWith('.mov') || src.startsWith('data:video')}
                {#if isVideo && overlayFilmstrips[ov.id]}
                  <!-- Filmstrip frame-by-frame (sprite-image stretchee sur toute la duree du clip) -->
                  <div class="clip-overlay-filmstrip" style:background-image={`url(${overlayFilmstrips[ov.id]})`}></div>
                {:else if isVideo}
                  <!-- svelte-ignore a11y_media_has_caption -->
                  <video class="clip-preview-thumb" src={src} muted playsinline preload="metadata"></video>
                {:else}
                  <img class="clip-preview-thumb" src={src} alt={ov.label ?? ''} />
                {/if}
                <span class="clip-preview text">{ov.label ?? 'video'}</span>
              {/if}
              <span class="clip-duration">{fmtT(ov.end_t - ov.start_t)}</span>
              <span
                class="clip-edge clip-edge-r"
                onpointerdown={(e) => startClipDrag(e, ov, 'resize-r')}
                role="button"
                tabindex="0"
                aria-label="trim end"
              ></span>
            </div>
          </div>
        </div>
      {/each}

      <!-- Video incrustations : empilees AVEC les autres overlays, AU-DESSUS de la video principale -->
      <!-- SAM2 + filtres = OPTION par incrustation (checkbox sam2_enabled), pas la valeur par defaut -->
      {#each sam2Regions as r, idx (r.id)}
        <div class="track-row sam2-track-row" class:err={r.status === 'error'} class:active={selectedSam2Id === r.id} class:disabled={r.enabled === false} class:expanded={expandedTracks[r.id]}>
          <span class="track-label sam2 sticky" title={`Video ${idx+1} - ${r.ui_name || 'aucun asset'}`}>
            <button type="button" class="track-chev" onclick={() => toggleExpand(r.id)} title={expandedTracks[r.id] ? 'Reduire' : 'Agrandir'}>{expandedTracks[r.id] ? '▾' : '▸'}</button>
            <span class="track-type">{r.sam2_enabled ? '⌖' : (r.ui_kind === 'video' ? '▶' : '🖼')}</span>
            <input
              type="text"
              class="track-name track-name-input"
              value={r.label ?? r.ui_name ?? `Video ${idx+1}`}
              placeholder={`Video ${idx+1}`}
              oninput={(e) => updateRegion(r.id, { label: (e.currentTarget as HTMLInputElement).value })}
            />
            <input
              type="checkbox"
              class="track-check"
              checked={r.enabled !== false}
              onchange={(e) => updateRegion(r.id, { enabled: (e.currentTarget as HTMLInputElement).checked })}
              title={r.enabled === false ? 'Activer video' : 'Desactiver video'}
            />
            <button
              type="button"
              class="track-mini del"
              class:armed={armedDeleteId === r.id}
              onclick={() => confirmDeleteSam2(r.id)}
              aria-label="delete"
              title={armedDeleteId === r.id ? 'Reclic pour confirmer' : 'Supprimer'}
            >
              {#if armedDeleteId === r.id}<span class="del-confirm">?</span>{:else}
                <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M2.5 4.5h11"/>
                  <path d="M6.5 4.5V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.5"/>
                  <path d="M4.5 4.5l.5 9a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1l.5-9"/>
                  <path d="M7 7v5"/>
                  <path d="M9 7v5"/>
                </svg>
              {/if}
            </button>
          </span>
          <div class="track-body">
            <div
              class="clip sam2-clip"
              class:running={r.status === 'running'}
              class:done={r.status === 'done'}
              class:err={r.status === 'error'}
              class:empty={!assetSrc(r)}
              style:left={secToPct(r.start_t) + '%'}
              style:width={secToPct(Math.max(0.5, r.end_t - r.start_t)) + '%'}
              title={`${r.ui_name || 'aucun asset'} (${r.ui_kind}) · ${fmtT(r.start_t)}-${fmtT(r.end_t)} · ${r.status}`}
              onpointerdown={(e) => startSam2Drag(e, r, 'move')}
              role="button"
              tabindex="0"
            >
              {#if r.poster_url}
                <div class="sam2-filmstrip" style:background-image={`url(${r.poster_url})`}></div>
              {/if}
              <span class="clip-icon">{assetSrc(r) ? (r.sam2_enabled ? '⌖' : (r.ui_kind === 'video' ? '▶' : '🖼')) : '⊕'}</span>
              <span class="clip-label">{r.ui_name || 'link asset…'}{r.sam2_enabled ? ' · SAM2' : ''}</span>
              {#if r.status === 'running' && r.progress}
                <div class="clip-progress" style:width={r.progress.percent + '%'}></div>
              {/if}
              <div class="clip-edge clip-edge-l" onpointerdown={(e) => startSam2Drag(e, r, 'resize-l')} role="presentation"></div>
              <div class="clip-edge clip-edge-r" onpointerdown={(e) => startSam2Drag(e, r, 'resize-r')} role="presentation"></div>
            </div>
          </div>
        </div>
      {/each}

      <!-- Separateur visuel V/A -->
      <div class="track-divider" aria-hidden="true"></div>

      <!-- Video master track (en bas) -->
      <div class="track-row" class:disabled={!videoTrackEnabled} class:expanded={expandedTracks['video']}>
        <span class="track-label video sticky">
          <button type="button" class="track-chev" onclick={() => toggleExpand('video')} title={expandedTracks['video'] ? 'Reduire' : 'Agrandir'}>{expandedTracks['video'] ? '▾' : '▸'}</button>
          <span class="track-name"><Icon name="Film" size={14} /> Video</span>
          <button type="button" class="track-mini" onclick={addRush} title="Ajouter un rush a partir de la position actuelle">+R</button>
          <input type="checkbox" class="track-check" checked={videoTrackEnabled} onchange={() => { videoTrackEnabled = !videoTrackEnabled; dirty = true; }} title="Activer / desactiver track video" />
          <button type="button" class="track-mini del" class:armed={armedDeleteId === 'video'}
            onclick={() => { if (armedDeleteId === 'video') { videoTrackEnabled = false; armedDeleteId = null; } else { armDelete('video'); } }}
            aria-label="delete video" title={armedDeleteId === 'video' ? 'Reclic pour confirmer' : 'Supprimer video'}>
            {#if armedDeleteId === 'video'}<span class="del-confirm">?</span>{:else}
              <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4.5h11"/><path d="M6.5 4.5V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.5"/><path d="M4.5 4.5l.5 9a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1l.5-9"/><path d="M7 7v5"/><path d="M9 7v5"/></svg>
            {/if}
          </button>
        </span>
        <div class="track-body">
          <!-- Master video clip : 1 sprite-image continue (timeline-aligned, scale au zoom) -->
          <div class="clip clip-master video-clip" style:left="0%" style:width="100%">
            {#if showFrames && masterFilmstrip}
              <div class="master-filmstrip" style:background-image={`url(${masterFilmstrip})`}></div>
            {/if}
            <span class="clip-label master-label">master · {fmtT(totalDur)}</span>
            <!-- Rushes : interactive markers (drag, resize, split, delete) -->
            {#if showFrames}
              {#each rushes as rush, i (i + '_' + rush.start_t)}
                <div
                  class="rush-marker editable"
                  style:left={secToPct(rush.start_t) + '%'}
                  style:width={secToPct(rush.end_t - rush.start_t) + '%'}
                  style:border-color={rush.color ?? 'var(--accent)'}
                  title={`${rush.label ?? `rush ${i+1}`} · ${fmtT(rush.start_t)}-${fmtT(rush.end_t)}`}
                  onpointerdown={(e) => startRushDrag(e, i, 'move')}
                  role="button"
                  tabindex="0"
                >
                  <span class="rush-edge l" onpointerdown={(e) => startRushDrag(e, i, 'resize-l')} role="presentation"></span>
                  <span class="rush-marker-label">{rush.label ?? `R${i+1}`}</span>
                  <button type="button" class="rush-action split" onclick={(e) => { e.stopPropagation(); splitRushAtCurrent(i); }} title="Couper a la position actuelle">✂</button>
                  <button type="button" class="rush-action del" onclick={(e) => { e.stopPropagation(); deleteRush(i); }} title="Supprimer ce rush">×</button>
                  <span class="rush-edge r" onpointerdown={(e) => startRushDrag(e, i, 'resize-r')} role="presentation"></span>
                </div>
              {/each}
            {/if}
          </div>
        </div>
      </div>

      <!-- Audio master track -->
      <div class="track-row" class:disabled={!audioTrackEnabled} class:expanded={expandedTracks['audio']}>
        <span class="track-label audio sticky">
          <button type="button" class="track-chev" onclick={() => toggleExpand('audio')} title={expandedTracks['audio'] ? 'Reduire' : 'Agrandir'}>{expandedTracks['audio'] ? '▾' : '▸'}</button>
          <span class="track-name"><Icon name="Mic" size={14} /> Audio</span>
          <input
            type="range" class="vol-slider"
            min="0" max="1" step="0.05" value={audioVolume}
            oninput={(e) => setAudioVolume(+(e.currentTarget as HTMLInputElement).value)}
            aria-label="Audio volume"
          />
          <span class="vol-val">{Math.round(audioVolume * 100)}</span>
          <input type="checkbox" class="track-check" checked={audioTrackEnabled} onchange={() => { audioTrackEnabled = !audioTrackEnabled; dirty = true; }} title="Activer / desactiver track audio" />
          <button type="button" class="track-mini del" class:armed={armedDeleteId === 'audio'}
            onclick={() => { if (armedDeleteId === 'audio') { audioTrackEnabled = false; armedDeleteId = null; } else { armDelete('audio'); } }}
            aria-label="delete audio" title={armedDeleteId === 'audio' ? 'Reclic pour confirmer' : 'Supprimer audio'}>
            {#if armedDeleteId === 'audio'}<span class="del-confirm">?</span>{:else}
              <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4.5h11"/><path d="M6.5 4.5V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.5"/><path d="M4.5 4.5l.5 9a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1l.5-9"/><path d="M7 7v5"/><path d="M9 7v5"/></svg>
            {/if}
          </button>
        </span>
        <div class="track-body">
          <div class="clip clip-master audio-clip" style:left="0%" style:width="100%" style:opacity={0.4 + audioVolume * 0.6}>
            {#if showWaveform && waveform.length > 0}
              <svg class="waveform" preserveAspectRatio="none" viewBox={`0 0 ${waveform.length} 100`}>
                {#each waveform as amp, i}
                  <rect
                    x={i}
                    y={50 - amp * 45}
                    width="0.85"
                    height={amp * 90}
                    fill="currentColor"
                  />
                {/each}
              </svg>
            {:else}
              <span class="clip-label">
                {#if videoEl && (videoEl as HTMLVideoElement & { webkitAudioDecodedByteCount?: number }).webkitAudioDecodedByteCount === 0}
                  ⚠ video sans piste audio ({fmtT(totalDur)})
                {:else}
                  voiceover FR ({fmtT(totalDur)})
                {/if}
              </span>
            {/if}
          </div>
          {#if showSync}
            {#each syncPoints as sp}
              <span class="sync-marker audio" style:left={secToPct(sp.t) + '%'} title={sp.label ?? `sync @ ${fmtT(sp.t)}`}></span>
            {/each}
          {/if}
        </div>
      </div>

      <!-- Music track : disparait totalement si checkbox decoche OU si toolbar Music off -->
      {#if showMusic && musicTrackEnabled}
        <div class="track-row" class:expanded={expandedTracks['music']}>
          <span class="track-label music sticky">
            <button type="button" class="track-chev" onclick={() => toggleExpand('music')} title={expandedTracks['music'] ? 'Reduire' : 'Agrandir'}>{expandedTracks['music'] ? '▾' : '▸'}</button>
            <span class="track-name"><Icon name="Music" size={14} /> Music</span>
            {#if music}
              <input
                type="range" class="vol-slider"
                min="0" max="1" step="0.05" value={musicVolume}
                oninput={(e) => setMusicVolume(+(e.currentTarget as HTMLInputElement).value)}
                aria-label="Music volume"
              />
              <span class="vol-val">{Math.round(musicVolume * 100)}</span>
            {/if}
            <input type="checkbox" class="track-check" checked={musicTrackEnabled} onchange={() => { musicTrackEnabled = !musicTrackEnabled; dirty = true; }} title="Desactiver et cacher la ligne music" />
            <button type="button" class="track-mini del" class:armed={armedDeleteId === 'music'}
              onclick={() => { if (armedDeleteId === 'music') { musicTrackEnabled = false; armedDeleteId = null; } else { armDelete('music'); } }}
              aria-label="delete music" title={armedDeleteId === 'music' ? 'Reclic pour confirmer' : 'Supprimer music'}>
              {#if armedDeleteId === 'music'}<span class="del-confirm">?</span>{:else}
                <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4.5h11"/><path d="M6.5 4.5V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.5"/><path d="M4.5 4.5l.5 9a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1l.5-9"/><path d="M7 7v5"/><path d="M9 7v5"/></svg>
              {/if}
            </button>
          </span>
          <div class="track-body">
            {#if music}
              <div
                class="clip clip-master music-clip"
                style:left={secToPct(music.start_t) + '%'}
                style:width={secToPct(music.end_t - music.start_t) + '%'}
                title={music.name ?? 'bande son'}
                style:opacity={0.4 + musicVolume * 0.6}
              >
                {#if showWaveform && musicWaveform.length > 0}
                  <svg class="waveform music-wave" preserveAspectRatio="none" viewBox={`0 0 ${musicWaveform.length} 100`}>
                    {#each musicWaveform as amp, i}
                      <rect x={i} y={50 - amp * 45} width="0.85" height={amp * 90} fill="currentColor" />
                    {/each}
                  </svg>
                {/if}
                <span class="clip-label">{music.name ?? 'bande son'} · vol {Math.round(musicVolume * 100)}%</span>
              </div>
            {:else}
              <div class="clip-empty">Aucune bande son · ajouter via output_assets.music_track</div>
            {/if}
          </div>
        </div>
      {/if}
      </div>
    </div>
  </div>
</div>

<style>
  .comp-editor { display: flex; flex-direction: column; gap: 12px; }
  .toolbar {
    display: flex; align-items: center; gap: 10px;
    padding: 8px 12px;
    background: rgba(255, 255, 255, 0.05);
    backdrop-filter: blur(12px) saturate(160%);
    -webkit-backdrop-filter: blur(12px) saturate(160%);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: var(--radius-md);
    flex-wrap: wrap;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08);
  }
  .btn-add, .btn-save {
    background: rgba(255, 255, 255, 0.07);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    border: 1px solid rgba(255, 255, 255, 0.15);
    color: var(--text); padding: 6px 12px; border-radius: var(--radius-sm);
    cursor: pointer; font-family: inherit; font-size: var(--text-body-sm);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.12);
  }
  .btn-save { background: rgba(255, 91, 20, 0.45); border-color: rgba(255, 91, 20, 0.6); color: var(--text); }
  .btn-save:disabled { opacity: .5; cursor: not-allowed; }
  .btn-add:hover { background: rgba(255, 255, 255, 0.12); }
  .toolbar-sep { width: 1px; height: 16px; background: var(--glass-border); }
  .toolbar-spacer { flex: 1; }
  .info { font-size: var(--text-micro); color: var(--text-tertiary); font-family: var(--font-mono); }
  .save-msg { font-size: var(--text-micro); color: var(--text-secondary); font-family: var(--font-mono); }
  .save-msg.err { color: var(--error); }

  .editor-row { display: grid; grid-template-columns: 1fr 280px; gap: 16px; align-items: start; }
  .frame-wrap { display: flex; justify-content: center; background: var(--bg); border: 1px solid var(--glass-border); border-radius: var(--radius-lg); padding: 16px; }
  /* Preview verticale (9:16, 4:5, 1:1) : agrandie + responsive (utilise l'espace dispo,
     ~40vw, plafonnee a 500px pour rester raisonnable). Avant : fixe 360px = trop petit. */
  .frame-wrap.vertical { max-width: clamp(360px, 40vw, 500px); margin: 0 auto; }
  .frame { position: relative; width: 100%; background: #000; border-radius: var(--radius-md); overflow: hidden; }
  .video-bg { display: block; width: 100%; height: 100%; }
  .no-video { display: flex; align-items: center; justify-content: center; height: 100%; min-height: 200px; color: var(--text-tertiary); font-size: var(--text-body-sm); }

  .overlay-box {
    position: absolute;
    cursor: move;
    display: flex; align-items: center; justify-content: center;
    user-select: none;
    touch-action: none;
    outline: 1px dashed transparent;
    outline-offset: -1px;
  }
  .overlay-box:hover { outline-color: var(--accent); }
  .overlay-box.selected {
    outline: 1px solid var(--accent);
    outline-offset: -1px;
  }
  .ov-text { font-weight: 600; text-shadow: 0 1px 2px rgba(0,0,0,0.6); pointer-events: none; display: block; width: 100%; }
  .ov-text-multi { pointer-events: none; display: block; width: 100%; text-shadow: 0 1px 2px rgba(0,0,0,0.6); }
  .ov-img { width: 100%; height: 100%; object-fit: contain; pointer-events: none; }
  .overlay-box.ov-glass { background: rgba(124,58,237,0.18) !important; backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); border: 1px solid rgba(255,255,255,0.4); box-shadow: inset 0 1px 0 rgba(255,255,255,0.35), inset 0 -1px 0 rgba(255,255,255,0.12); border-radius: 16px; }
  .glass-toggle { display: flex; align-items: center; gap: 6px; margin-top: 6px; font-size: 12px; color: var(--text-secondary, #94A3B8); cursor: pointer; }
  .resize-handle {
    position: absolute; right: -6px; bottom: -6px;
    width: 12px; height: 12px;
    background: var(--accent); border-radius: 50%;
    cursor: nwse-resize;
  }

  .props-panel {
    background: rgba(255, 255, 255, 0.05);
    backdrop-filter: blur(20px) saturate(180%);
    -webkit-backdrop-filter: blur(20px) saturate(180%);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: var(--radius-lg); padding: 12px;
    max-height: 600px; overflow-y: auto;
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.15),
      0 8px 32px rgba(0, 0, 0, 0.25);
  }
  .props-panel h3 { font-size: var(--text-body-sm); font-weight: 600; margin: 0 0 8px; color: var(--text); }
  .props-panel h4 { font-size: var(--text-micro); font-weight: 600; margin: 12px 0 6px; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.5px; }
  .ov-row.active .ov-row-btn { border-color: var(--accent); background: var(--surface-active); }

  .bg-presets { display: flex; gap: 4px; margin-top: 4px; flex-wrap: wrap; }
  .bg-pst {
    flex: 1; min-width: 50px;
    padding: 4px 6px; border: 1px solid var(--glass-border);
    border-radius: var(--radius-xs); cursor: pointer;
    font-size: var(--text-micro); font-family: inherit;
    color: var(--text);
  }
  .bg-pst.orange { background: #FF5B14; color: #fff; }
  .bg-pst.dim { background: rgba(0,0,0,0.4); color: #fff; }
  .bg-pst.dark { background: rgba(0,0,0,0.7); color: #fff; }
  .bg-pst:hover { border-color: var(--accent); }
  .shape-presets { display: flex; gap: 4px; margin-top: 2px; }

  /* ---- Compact UI panel ---- */
  .ph-icon {
    color: var(--text-tertiary);
    font-size: 13px; font-weight: 600;
    width: 14px; text-align: center; flex-shrink: 0;
  }
  .full-btn {
    background: rgba(255, 255, 255, 0.06);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    border: 1px dashed rgba(255, 255, 255, 0.18);
    color: var(--text-secondary);
    padding: 5px 10px;
    border-radius: var(--radius-xs);
    cursor: pointer;
    font-family: inherit;
    font-size: var(--text-micro);
    width: 100%;
  }
  .full-btn:hover { border-color: var(--accent); color: var(--text); }

  .ctrl-row { display: flex; gap: 6px; }
  .micro-field {
    flex: 1;
    display: flex; align-items: center; gap: 4px;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: var(--radius-xs);
    padding: 3px 6px;
    min-width: 0;
  }
  .micro-field input {
    flex: 1; min-width: 0;
    background: none; border: none; padding: 0;
    color: var(--text); font-size: var(--text-body-sm); font-family: inherit;
    outline: none;
  }
  .icon-btn {
    flex: 1;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: var(--radius-xs);
    padding: 5px 8px;
    color: var(--text-secondary);
    cursor: pointer;
    font-family: inherit; font-size: 13px;
    line-height: 1;
  }
  .icon-btn.active { background: rgba(255, 91, 20, 0.25); border-color: var(--accent); color: var(--accent); }
  .icon-btn:hover:not(.active) { border-color: var(--accent); color: var(--text); }
  .icon-btn.small { flex: 0 0 auto; padding: 2px 8px; font-size: 11px; }

  /* ---- Panel V2 : sections collapsibles compact ---- */
  .prop-edit-v2 {
    display: flex; flex-direction: column; gap: 8px; margin-top: 12px;
    overflow-x: hidden;
    min-width: 0;
  }
  .prop-edit-v2 input, .prop-edit-v2 select { min-width: 0; }
  .hero-input {
    display: flex; align-items: stretch; gap: 4px;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: var(--radius-xs);
    padding: 2px 2px 2px 8px;
  }
  .hero-input input[type="text"] {
    flex: 1; background: none; border: none; padding: 4px 0;
    color: var(--text); font-size: var(--text-body-sm); font-family: inherit;
    outline: none; min-width: 0;
  }
  .hero-btn {
    display: inline-flex; align-items: center; justify-content: center;
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: var(--radius-xs);
    color: var(--text-secondary);
    cursor: pointer;
    padding: 0 8px; min-width: 26px; height: 24px;
    font-family: inherit; font-size: 12px;
  }
  .hero-btn:hover { background: rgba(255, 91, 20, 0.2); color: var(--accent); border-color: var(--accent); }

  .acc-section {
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: var(--radius-xs);
    background: rgba(255, 255, 255, 0.02);
    overflow: hidden;
  }
  .acc-header {
    width: 100%;
    display: flex; align-items: center; gap: 6px;
    background: rgba(255, 255, 255, 0.04);
    border: none;
    padding: 6px 8px;
    color: var(--text-secondary);
    cursor: pointer;
    font-family: inherit;
    font-size: var(--text-micro);
    text-align: left;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .acc-header:hover { background: rgba(255, 255, 255, 0.07); color: var(--text); }
  .acc-chev { color: var(--text-tertiary); width: 10px; flex-shrink: 0; }
  .acc-title { flex: 1; font-weight: 600; }
  .acc-body {
    padding: 6px;
    display: flex; flex-direction: column; gap: 6px;
    background: rgba(255, 255, 255, 0.015);
  }

  .swatch-field {
    flex: 1; min-width: 0;
    display: flex; align-items: center; gap: 4px;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: var(--radius-xs);
    padding: 2px 4px;
  }
  .swatch-field.full { flex: 2; }
  .swatch-field input[type="color"] {
    width: 22px; height: 22px;
    padding: 0; cursor: pointer;
    background: none; border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: var(--radius-xs);
    flex-shrink: 0;
  }
  .swatch-field input[type="text"] {
    flex: 1; min-width: 0;
    background: none; border: none; padding: 0;
    color: var(--text); font-size: var(--text-micro); font-family: var(--font-mono); outline: none;
  }
  .swatch-hex {
    font-family: var(--font-mono); font-size: var(--text-micro);
    color: var(--text-tertiary);
  }
  .swatch-box {
    width: 22px; height: 22px;
    border-radius: var(--radius-xs);
    border: 1px solid rgba(255, 255, 255, 0.15);
    flex-shrink: 0;
    background-image: linear-gradient(45deg, rgba(255,255,255,0.1) 25%, transparent 25%, transparent 75%, rgba(255,255,255,0.1) 75%),
                      linear-gradient(45deg, rgba(255,255,255,0.1) 25%, transparent 25%, transparent 75%, rgba(255,255,255,0.1) 75%);
    background-size: 8px 8px;
    background-position: 0 0, 4px 4px;
  }

  .align-grid-compact {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 3px;
  }
  .align-grid-compact .align-cell {
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: var(--radius-xs);
    height: 24px;
    color: var(--text-tertiary);
    cursor: pointer;
    font-family: inherit; font-size: 12px;
    display: flex; align-items: center; justify-content: center;
  }
  .align-grid-compact .align-cell:hover { border-color: var(--accent); color: var(--accent); }
  .align-grid-compact .align-cell.center { color: var(--accent); }

  .bg-pst.small { padding: 2px 8px; font-size: 10px; min-width: auto; flex: 0 0 auto; }
  .align-cell {
    background: var(--surface-hover); border: 1px solid var(--glass-border);
    border-radius: var(--radius-xs);
    width: 28px; height: 28px;
    cursor: pointer;
    color: var(--text-secondary);
    font-size: 14px; line-height: 1;
    display: flex; align-items: center; justify-content: center;
    font-family: inherit;
  }
  .align-cell:hover { border-color: var(--accent); color: var(--accent); }
  .align-cell.center { border-color: var(--glass-border); color: var(--accent); }

  @media (max-width: 720px) {
    .editor-row { grid-template-columns: 1fr; }
  }

  /* ---- Timeline (liquid glass card) ---- */
  .timeline-panel {
    background: rgba(255, 255, 255, 0.05);
    backdrop-filter: blur(20px) saturate(180%);
    -webkit-backdrop-filter: blur(20px) saturate(180%);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: var(--radius-lg);
    padding: 12px;
    display: flex; flex-direction: column; gap: 8px;
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.15),
      0 8px 32px rgba(0, 0, 0, 0.3);
  }
  .timeline-header {
    display: flex; align-items: center; gap: 12px;
    font-size: var(--text-body-sm);
  }
  .tl-title { font-weight: 600; color: var(--text); }
  .tl-spacer { flex: 1; }
  .tl-time { font-family: var(--font-mono); font-size: var(--text-micro); color: var(--text-secondary); }

  .tl-toggles { display: flex; gap: 4px; }
  .tg {
    background: var(--surface-hover); border: 1px solid var(--glass-border);
    color: var(--text-tertiary);
    padding: 3px 8px; border-radius: var(--radius-xs);
    font-size: var(--text-micro); cursor: pointer; font-family: inherit;
  }
  .tg.on { background: var(--surface-active); color: var(--accent); border-color: var(--accent); }
  .zoom-ctrl { display: flex; align-items: center; gap: 4px; margin-right: 8px; }
  .zoom-btn {
    background: var(--surface-hover); border: 1px solid var(--glass-border);
    color: var(--text); width: 22px; height: 22px; border-radius: var(--radius-xs);
    cursor: pointer; font-family: inherit;
  }
  .zoom-btn:disabled { opacity: .4; cursor: not-allowed; }
  .zoom-val { font-family: var(--font-mono); font-size: var(--text-micro); color: var(--text-secondary); min-width: 32px; text-align: center; }

  .tracks-scroll {
    overflow-x: auto;
    overflow-y: hidden;
    background: transparent;
    border-radius: var(--radius-md);
  }
  .tracks { display: flex; flex-direction: column; gap: 4px; min-width: 100%; }
  .track-label.sticky {
    position: sticky;
    left: 0;
    z-index: 4;
    background: rgba(255, 255, 255, 0.06);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
  }
  .track-label.music { color: var(--accent); }
  .track-divider {
    height: 1px;
    background: var(--glass-border);
    margin: 6px 0;
    opacity: .6;
  }

  /* Rushes : injection alpha sur la couleur fournie par data */
  .music-clip {
    background: linear-gradient(90deg, rgba(183,148,244,0.4) 0%, rgba(183,148,244,0.7) 50%, rgba(183,148,244,0.4) 100%);
    background-size: 8px 100%;
  }
  .clip-empty {
    display: flex; align-items: center; justify-content: center;
    height: 100%; color: var(--text-tertiary);
    font-size: var(--text-micro); font-style: italic;
  }
  .waveform {
    position: absolute; inset: 0;
    width: 100%; height: 100%;
    color: var(--text);
    opacity: .8;
  }
  .waveform.music-wave {
    color: #ffffff;
    opacity: .9;
  }
  .music-clip {
    background: rgba(183, 148, 244, 0.28);
    backdrop-filter: blur(12px) saturate(160%);
    -webkit-backdrop-filter: blur(12px) saturate(160%);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.2),
      inset 0 -1px 0 rgba(0, 0, 0, 0.15);
    border: 1px solid rgba(255, 255, 255, 0.15);
  }
  .sync-marker {
    position: absolute; top: 0; bottom: 0;
    width: 2px; background: var(--warning);
    pointer-events: none; z-index: 3;
    box-shadow: 0 0 4px var(--warning);
  }
  .sync-marker.audio { background: var(--warning); opacity: .6; }

  .vol-slider {
    flex: 1; min-width: 0;
    accent-color: var(--accent);
    margin: 0 4px;
    height: 12px;
  }
  .vol-val {
    font-family: var(--font-mono); font-size: 9px;
    color: var(--text-tertiary);
    min-width: 18px; text-align: right;
  }
  .img-preview {
    margin-top: 4px;
    background: var(--surface-active);
    border: 1px solid var(--glass-border); border-radius: var(--radius-xs);
    padding: 6px; display: flex; justify-content: center;
    max-height: 100px; overflow: hidden;
  }
  .img-preview img { max-width: 100%; max-height: 80px; object-fit: contain; }
  .track-label.audio.sticky, .track-label.music.sticky {
    /* width retiree : la colonne grid (--sticky-col) controle la largeur uniformement */
    display: flex; align-items: center; gap: 4px;
  }
  .track-check {
    margin-left: auto;
    width: 14px; height: 14px;
    accent-color: var(--accent);
    cursor: pointer;
    flex-shrink: 0;
  }
  .track-label.sticky {
    display: flex; align-items: center; gap: 4px;
  }
  .track-label.overlay .track-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .track-row {
    display: grid;
    grid-template-columns: var(--sticky-col, 180px) 1fr;
    gap: 8px;
    align-items: stretch;
    min-height: 32px;
    transition: min-height 0.18s ease, filter 0.15s;
  }
  /* Resizer vertical : zone invisible 8px de large + ligne 2px visible au hover */
  .tracks-scroll { position: relative; }
  .col-resizer {
    position: absolute;
    top: 0; bottom: 0;
    width: 8px;
    margin-left: -4px;
    cursor: col-resize;
    z-index: 10;
    background: transparent;
    transition: background 0.15s;
  }
  .col-resizer::before {
    content: '';
    position: absolute;
    top: 0; bottom: 0; left: 3px;
    width: 2px;
    background: transparent;
    transition: background 0.15s;
  }
  .col-resizer:hover::before,
  .col-resizer:active::before { background: var(--accent); }
  .track-row.expanded {
    min-height: 88px;                         /* row plus haute en mode expand */
  }
  .track-row.disabled {
    filter: grayscale(1);
  }
  /* Versions menu (save history) */
  .versions-wrap { position: relative; }
  .versions-menu {
    position: absolute;
    top: 100%; right: 0;
    margin-top: 4px;
    width: 320px;
    max-height: 380px;
    overflow-y: auto;
    background: rgba(20, 20, 24, 0.96);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 6px;
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.5);
    backdrop-filter: blur(12px);
    z-index: 100;
    padding: 8px;
  }
  .versions-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: var(--text-micro);
    color: var(--text);
    margin-bottom: 6px;
    padding-bottom: 6px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  }
  .versions-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .versions-list li {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 6px;
    background: rgba(255, 255, 255, 0.03);
    border-radius: 4px;
  }
  .versions-list li:hover { background: rgba(255, 255, 255, 0.06); }

  /* Reorder handle : 14x18px, cursor grab, dots vertical */
  .reorder-handle {
    color: var(--text-tertiary);
    cursor: grab;
    user-select: none;
    font-size: 10px;
    line-height: 1;
    flex-shrink: 0;
    width: 12px;
    text-align: center;
    letter-spacing: -2px;
    font-family: var(--font-mono);
  }
  .reorder-handle:hover { color: var(--text); }
  .reorder-handle:active { cursor: grabbing; }

  /* Track row lifted pendant reorder drag */
  .track-row.reordering {
    transform: translateY(-3px) scale(1.005);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45), 0 0 0 1px var(--accent);
    z-index: 50;
    position: relative;
    transition: transform 0.12s ease, box-shadow 0.15s ease;
  }
  .track-row.reordering .track-label.sticky {
    background: rgba(255, 91, 20, 0.18);
  }
  .track-row.reordering .reorder-handle {
    color: var(--accent);
    cursor: grabbing;
  }

  /* Mini-frame : visualise la position x/y/w/h de l overlay sur la video principale */
  .pos-mini {
    height: calc(100% - 6px);
    margin: 3px 6px 3px 4px;
    background: rgba(0, 0, 0, 0.4);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 2px;
    position: relative;
    flex-shrink: 0;
  }
  .pos-mini-rect {
    position: absolute;
    background: rgba(255, 255, 255, 0.85);
    border: 1px solid var(--accent);
    border-radius: 1px;
    min-width: 2px;
    min-height: 2px;
  }
  .track-row.expanded .pos-mini {
    height: calc(100% - 10px);
    margin: 5px 8px 5px 5px;
    border-width: 1.5px;
  }
  .track-row.expanded .pos-mini-rect {
    background: rgba(255, 255, 255, 0.95);
    box-shadow: 0 0 4px rgba(255, 91, 20, 0.4);
  }

  /* Clip content preview : texte rendered + thumbnail si image/video */
  .clip-preview {
    flex: 1 1 0;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding: 0 8px;
    font-size: 12px;
    font-weight: 500;
    line-height: 1.2;
    letter-spacing: 0.2px;
  }
  .clip-preview.text {
    color: #fff;
    text-shadow: 0 1px 3px rgba(0, 0, 0, 0.85), 0 0 1px rgba(0, 0, 0, 0.6);
  }
  /* Thumbnail plus large, scale aussi avec row expanded */
  .clip-preview-thumb {
    height: 100%;
    aspect-ratio: 16 / 9;
    width: auto;
    max-width: 50%;
    object-fit: cover;
    border-radius: 3px 0 0 3px;
    flex-shrink: 0;
    opacity: 1;
    background: rgba(0, 0, 0, 0.2);
  }
  /* Filmstrip frame-by-frame pour overlay video : sprite stretchee 100% 100% */
  .clip-overlay-filmstrip {
    position: absolute;
    inset: 0;
    background-size: 100% 100%;
    background-position: 0 0;
    background-repeat: no-repeat;
    border-radius: 3px;
    opacity: 1;
    pointer-events: none;
  }
  /* Sur row expanded : thumbnail nettement plus grand, texte plus visible */
  .track-row.expanded .clip-preview { font-size: 16px; font-weight: 600; white-space: normal; line-height: 1.25; padding: 4px 10px; }
  .track-row.expanded .clip-preview-thumb { aspect-ratio: 16 / 9; max-width: 35%; }

  .clip-duration {
    flex-shrink: 0;
    font-family: var(--font-mono);
    font-size: 9px;
    color: rgba(255, 255, 255, 0.85);
    padding: 1px 6px;
    background: rgba(0, 0, 0, 0.45);
    border-radius: 3px;
    align-self: flex-start;
    margin-top: 4px;
    margin-right: 4px;
  }
  /* Chevron compact : 12x18px */
  .track-chev {
    background: transparent;
    border: none;
    color: var(--text-tertiary);
    padding: 0;
    margin-right: 4px;
    width: 14px;
    height: 18px;
    cursor: pointer;
    font-size: 10px;
    line-height: 1;
    flex-shrink: 0;
  }
  .track-chev:hover { color: var(--text); }

  /* Master video filmstrip : 1 sprite-image stretchee, time-aligned (1px == 1 unit time) */
  .master-filmstrip {
    position: absolute;
    inset: 2px;
    background-size: 100% 100%;
    background-position: 0 0;
    background-repeat: no-repeat;
    border-radius: 3px;
    opacity: 0.9;
  }
  .clip-master.video-clip {
    overflow: hidden;
    position: absolute;
    top: 2px; bottom: 2px;
  }
  .master-label {
    position: relative;
    z-index: 2;
    padding: 0 6px;
    background: rgba(0, 0, 0, 0.55);
    border-radius: 3px;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.7);
  }
  /* Narrative segment marker : juste un bord coloré + label, posé sur la filmstrip */
  .rush-marker {
    position: absolute;
    top: 2px; bottom: 2px;
    border: 2px solid var(--accent);
    border-radius: 3px;
    background: transparent;
    pointer-events: none;
    z-index: 1;
  }
  .rush-marker-label {
    position: absolute;
    top: 2px; left: 4px;
    font-size: 10px;
    font-family: var(--font-mono);
    color: #fff;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
    padding: 0 4px;
    background: rgba(0, 0, 0, 0.5);
    border-radius: 2px;
    pointer-events: none;
  }
  .rush-marker.editable {
    pointer-events: auto;
    cursor: grab;
  }
  .rush-marker.editable:active { cursor: grabbing; }
  .rush-marker.editable:hover { background: rgba(255, 91, 20, 0.08); }
  .rush-edge {
    position: absolute;
    top: 0; bottom: 0;
    width: 6px;
    cursor: ew-resize;
    background: transparent;
    z-index: 2;
  }
  .rush-edge.l { left: -3px; }
  .rush-edge.r { right: -3px; }
  .rush-edge:hover { background: rgba(255, 91, 20, 0.5); }
  .rush-action {
    position: absolute;
    top: 2px;
    width: 18px; height: 18px;
    background: rgba(0, 0, 0, 0.7);
    border: 1px solid var(--accent);
    border-radius: 3px;
    color: #fff;
    font-size: 11px;
    line-height: 1;
    cursor: pointer;
    padding: 0;
    opacity: 0.6;            /* visible en permanence (pas seulement au hover) */
    transition: opacity 0.12s, transform 0.1s;
    z-index: 3;
  }
  .rush-marker.editable:hover .rush-action { opacity: 1; }
  .rush-action:hover { transform: scale(1.15); opacity: 1; }
  .rush-action.split { right: 24px; }
  .rush-action.del { right: 4px; background: rgba(239, 68, 68, 0.8); border-color: #ef4444; }

  /* Expanded track : clips et waveforms gagnent en hauteur naturellement */
  .track-row.expanded .clip,
  .track-row.expanded .clip-master {
    top: 4px; bottom: 4px;
  }
  .track-row.expanded .waveform {
    transform: scaleY(1.5);
    transform-origin: center;
  }
  .track-row.expanded .master-filmstrip img {
    opacity: 1;
  }
  .track-label {
    font-size: var(--text-micro);
    color: var(--text-secondary);
    font-family: var(--font-mono);
    padding: 4px 8px;
    background: var(--surface-hover);
    border-radius: var(--radius-xs);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    display: flex; align-items: center; gap: 4px;
    min-width: 0;                              /* permet aux enfants de retrecir */
    box-sizing: border-box;
  }
  /* Volume slider : shrinkable et compact pour ne pas deborder la colonne */
  .track-label .vol-slider {
    flex: 0 1 60px;
    min-width: 30px;
    width: auto;
  }
  .track-label .vol-val {
    font-size: 9px;
    color: var(--text-tertiary);
    flex-shrink: 0;
  }
  .track-label .track-name {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* Input editable inline pour renommer le track */
  .track-name-input {
    flex: 1 1 auto;
    min-width: 0;
    background: transparent;
    border: 1px solid transparent;
    color: inherit;
    font-family: inherit;
    font-size: inherit;
    padding: 1px 4px;
    border-radius: 3px;
    outline: none;
    width: 100%;
  }
  .track-name-input:hover { border-color: rgba(255, 255, 255, 0.08); }
  .track-name-input:focus { border-color: var(--accent); background: rgba(255, 91, 20, 0.06); }
  /* Actions (checkbox + del) toujours collees a droite, alignees verticalement */
  .track-label .track-check,
  .track-label .track-mini.del,
  .track-label .track-mini.upload,
  .track-label > input[type="checkbox"] {
    flex-shrink: 0;
  }
  /* Actions group : poussees a droite */
  .track-label .track-check { margin-left: auto; }
  /* Spacer invisible pour tracks sans del (video/audio/music) — match del button outer width (22+2 ml) */
  .track-label.video { color: var(--accent); }
  .track-label.audio { color: var(--agent-running); }
  .track-label.overlay { color: var(--text-secondary); }
  .track-type {
    font-size: 9px;
    background: var(--surface-active);
    padding: 1px 4px;
    border-radius: var(--radius-xs);
    color: var(--text-tertiary);
  }
  .track-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .track-body {
    position: relative;
    height: 100%;
    min-height: 28px;
    background: rgba(255, 91, 20, 0.12);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: var(--radius-xs);
    overflow: hidden;
  }
  .ruler-body {
    cursor: pointer;
    background: rgba(255, 91, 20, 0.12);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    height: 24px;
    border: 1px solid rgba(255, 255, 255, 0.08);
  }
  /* Tous les tracks ont le meme glass orange-tinted que le ruler */
  .ruler-tick {
    position: absolute;
    top: 0; bottom: 0;
    border-left: 1px solid var(--glass-border);
    pointer-events: none;
  }
  .ruler-label {
    position: absolute;
    top: 4px; left: 2px;
    font-size: 9px;
    font-family: var(--font-mono);
    color: var(--text-tertiary);
    pointer-events: none;
  }
  .playhead {
    position: absolute;
    top: 0; bottom: 0;
    width: 2px;
    background: var(--accent);
    pointer-events: none;
    z-index: 5;
    box-shadow: 0 0 4px var(--accent);
  }

  .clip {
    position: absolute;
    top: 2px; bottom: 2px;
    border-radius: var(--radius-xs);
    border: 1px solid transparent;
    display: flex; align-items: center;
    overflow: hidden;
    user-select: none;
    touch-action: none;
  }
  .clip-master {
    pointer-events: none;
  }
  .video-clip { background: var(--accent); opacity: .65; }
  .audio-clip {
    background: rgba(59, 130, 246, 0.28);
    backdrop-filter: blur(12px) saturate(160%);
    -webkit-backdrop-filter: blur(12px) saturate(160%);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.2),
      inset 0 -1px 0 rgba(0, 0, 0, 0.15);
    border: 1px solid rgba(255, 255, 255, 0.15);
  }
  .clip-overlay {
    cursor: grab;
    border: 1px solid rgba(255, 255, 255, 0.18);
    background: rgba(255, 91, 20, 0.35);
    backdrop-filter: blur(12px) saturate(160%);
    -webkit-backdrop-filter: blur(12px) saturate(160%);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.25),
      inset 0 -1px 0 rgba(0, 0, 0, 0.15),
      0 2px 6px rgba(0, 0, 0, 0.25);
  }
  .clip-overlay:hover {
    border-color: rgba(255, 255, 255, 0.35);
    background-image: linear-gradient(180deg, rgba(255,255,255,0.08) 0%, transparent 100%);
  }
  /* Liquid glass variations par data-clip-color (jamais noir/gris) */
  .clip-overlay[data-clip-color="orange"] { background: rgba(255, 91, 20, 0.38); }
  .clip-overlay[data-clip-color="blue"]   { background: rgba(59, 130, 246, 0.38); }
  .clip-overlay[data-clip-color="green"]  { background: rgba(16, 185, 129, 0.38); }
  .clip-overlay[data-clip-color="yellow"] { background: rgba(245, 158, 11, 0.38); }
  .clip-overlay[data-clip-color="pink"]   { background: rgba(239, 68, 68, 0.38); }
  .clip-overlay[data-clip-color="cyan"]   { background: rgba(34, 197, 94, 0.38); }
  .clip-overlay:active { cursor: grabbing; }
  .clip-overlay.selected { border-color: var(--text); border-width: 2px; }
  .clip-label {
    flex: 1;
    text-align: center;
    font-size: 10px;
    font-family: var(--font-mono);
    color: var(--text);
    text-shadow: 0 1px 1px rgba(0,0,0,0.4);
    padding: 0 4px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    pointer-events: none;
  }
  .clip-edge {
    width: 6px;
    height: 100%;
    background: rgba(255,255,255,0.3);
    cursor: ew-resize;
    flex-shrink: 0;
  }
  .clip-edge:hover { background: rgba(255,255,255,0.6); }

  /* ===== SAM2 Screen Replace section (liquid glass, panel-level) ===== */
  .frame.pick-mode { cursor: crosshair; }
  .frame.pick-mode::after {
    content: '⌖ clique sur l ecran a tracker';
    position: absolute;
    top: 8px; left: 8px;
    font-size: 11px;
    font-family: var(--font-mono);
    color: var(--accent);
    background: rgba(255, 91, 20, 0.12);
    padding: 4px 8px;
    border-radius: 6px;
    pointer-events: none;
    backdrop-filter: blur(8px);
  }
  .sam2-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 5px 9px;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 6px;
    color: var(--text);
    font-size: var(--text-micro);
    cursor: pointer;
    white-space: nowrap;
  }
  .sam2-btn:hover:not(:disabled) { background: rgba(255, 255, 255, 0.1); }
  .sam2-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .sam2-btn.active { background: var(--accent); color: #fff; border-color: var(--accent); }
  .sam2-btn.run {
    background: var(--accent);
    color: #fff;
    border-color: var(--accent);
    font-weight: 600;
  }
  .sam2-btn.run:hover:not(:disabled) { filter: brightness(1.1); }
  .sam2-btn.upload { cursor: pointer; }
  .sam2-btn.small { padding: 3px 7px; font-size: 10px; }
  .sam2-btn.ghost {
    background: transparent;
    text-decoration: none;
    color: var(--text-secondary);
  }
  .sam2-meta {
    font-size: 10px;
    font-family: var(--font-mono);
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    flex: 1;
  }
  .sam2-meta.dim { color: var(--text-tertiary); font-style: italic; }
  .sam2-x {
    background: transparent;
    border: none;
    color: var(--text-tertiary);
    cursor: pointer;
    font-size: 14px;
    padding: 0 4px;
  }
  .sam2-x:hover { color: var(--text); }
  .sam2-bar {
    height: 4px;
    background: rgba(255, 255, 255, 0.08);
    border-radius: 2px;
    overflow: hidden;
    margin-top: 2px;
  }
  .sam2-fill {
    height: 100%;
    background: var(--accent);
    transition: width 0.4s ease;
  }

  /* Kind pill (image | video) */
  .sam2-pill {
    display: inline-block;
    padding: 1px 6px;
    font-size: 9px;
    font-family: var(--font-mono);
    font-weight: 600;
    text-transform: uppercase;
    background: rgba(255, 91, 20, 0.18);
    color: var(--accent);
    border-radius: 3px;
    letter-spacing: 0.5px;
  }

  /* Liste des regions sous le panel SAM2 */
  .sam2-region {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 6px;
    background: rgba(255, 255, 255, 0.04);
    border-radius: 4px;
    border: 1px solid rgba(255, 255, 255, 0.06);
  }
  .sam2-region-row {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    flex-wrap: wrap;
  }
  .sam2-region.err { border-color: rgba(176, 0, 32, 0.4); background: rgba(176, 0, 32, 0.08); }
  .sam2-status {
    font-size: 11px;
    font-family: var(--font-mono);
    margin-left: auto;
  }
  .sam2-status[data-status="done"] { color: #22c55e; }
  .sam2-status[data-status="error"] { color: #b00020; }
  .sam2-status[data-status="running"] { color: var(--accent); }

  /* Timeline track : SAM2 clip */
  .track-label.sam2 {
    color: var(--accent);
  }
  .sam2-track-row.active .track-label.sam2 { background: rgba(255, 91, 20, 0.12); }
  .selected-region {
    border: 1px solid rgba(255, 91, 20, 0.3);
    background: rgba(255, 91, 20, 0.06);
  }
  .panel-hint {
    padding: 10px;
    border: 1px dashed rgba(255, 255, 255, 0.08);
    border-radius: 6px;
  }
  .sam2-track-row .track-body {
    background: rgba(255, 91, 20, 0.04);
    border: 1px solid rgba(255, 91, 20, 0.15);
    border-radius: 4px;
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
  }
  .clip.sam2-clip {
    position: absolute;
    top: 2px; bottom: 2px;
    background: rgba(255, 91, 20, 0.22);
    border: 1px solid var(--accent);
    border-radius: 4px;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 8px;
    cursor: grab;
    overflow: hidden;
    color: var(--text);
    backdrop-filter: blur(10px) saturate(160%);
    -webkit-backdrop-filter: blur(10px) saturate(160%);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.12);
  }
  .clip.sam2-clip:active { cursor: grabbing; }
  .sam2-filmstrip {
    position: absolute;
    inset: 0;
    background-repeat: repeat-x;
    background-size: auto 100%;
    background-position: 0 0;
    opacity: 0.95;                /* full visibility, no plus de transparence */
    pointer-events: none;
    filter: saturate(115%);
  }
  .clip.sam2-clip .clip-icon,
  .clip.sam2-clip .clip-label {
    position: relative;
    z-index: 1;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
  }
  .clip.sam2-clip.running {
    border-style: dashed;
    animation: sam2-pulse 1.4s ease-in-out infinite;
  }
  .clip.sam2-clip.done { background: rgba(34, 197, 94, 0.18); border-color: #22c55e; }
  .clip.sam2-clip.err { background: rgba(176, 0, 32, 0.18); border-color: #b00020; }
  .clip.sam2-clip:hover { filter: brightness(1.1); }
  .clip.sam2-clip .clip-icon {
    font-size: 12px;
    flex-shrink: 0;
  }
  .clip.sam2-clip .clip-label {
    font-size: 10px;
    font-family: var(--font-mono);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .clip-progress {
    position: absolute;
    bottom: 0; left: 0;
    height: 2px;
    background: var(--accent);
    transition: width 0.4s ease;
  }
  @keyframes sam2-pulse {
    0%, 100% { box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.12), 0 0 0 0 rgba(255, 91, 20, 0.4); }
    50% { box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.12), 0 0 0 4px rgba(255, 91, 20, 0); }
  }

  /* SAM2 seed point : crosshair en pixels ecran (taille fixe peu importe le viewBox source) */
  .sam2-seed {
    position: absolute;
    width: 0; height: 0;
    pointer-events: none;
    z-index: 3;
  }
  .sam2-seed-ring {
    position: absolute;
    left: -18px; top: -18px;
    width: 36px; height: 36px;
    border-radius: 50%;
    border: 2px solid var(--accent);
    box-shadow: 0 0 12px rgba(255, 91, 20, 0.7), inset 0 0 6px rgba(255, 91, 20, 0.3);
    animation: sam2-seed-pulse 1.4s ease-in-out infinite;
  }
  .sam2-seed-cross-h, .sam2-seed-cross-v {
    position: absolute;
    background: var(--accent);
    box-shadow: 0 0 4px rgba(255, 91, 20, 0.8);
  }
  .sam2-seed-cross-h {
    left: -22px; top: -1px;
    width: 44px; height: 2px;
  }
  .sam2-seed-cross-v {
    left: -1px; top: -22px;
    width: 2px; height: 44px;
  }
  .sam2-seed-label {
    position: absolute;
    left: 26px; top: -28px;
    padding: 2px 6px;
    background: rgba(255, 91, 20, 0.95);
    color: #fff;
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 600;
    border-radius: 3px;
    white-space: nowrap;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
  }
  .sam2-bbox {
    position: absolute;
    pointer-events: none;
    border: 2px dashed var(--accent);
    background: rgba(255, 91, 20, 0.08);
    z-index: 3;
  }
  .sam2-bbox-label {
    position: absolute;
    top: -22px; left: 0;
    padding: 2px 6px;
    background: var(--accent);
    color: #fff;
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 600;
    border-radius: 3px 3px 0 0;
    white-space: nowrap;
  }
  @keyframes sam2-seed-pulse {
    0%, 100% { transform: scale(1); opacity: 0.9; }
    50% { transform: scale(1.4); opacity: 0.4; }
  }

  /* Video / image overlay rendu sur le frame (SAM2 off) */
  .video-overlay {
    position: absolute;
    overflow: hidden;
    pointer-events: none;
    /* feather = mask radial fade aux bords (var --feather injectee inline) */
    -webkit-mask-image: radial-gradient(ellipse closest-side, #000 calc(100% - var(--feather, 0px)), transparent 100%);
            mask-image: radial-gradient(ellipse closest-side, #000 calc(100% - var(--feather, 0px)), transparent 100%);
  }
  .video-overlay .ov-video {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  /* Empty SAM2 clip (asset pas encore link) */
  .clip.sam2-clip.empty {
    border-style: dashed;
    background: rgba(255, 91, 20, 0.06);
  }

  /* SAM2 toggle checkbox + filters row */
  .sam2-region-row.filters {
    gap: 6px;
  }
  .sam2-region-row.asset-row {
    align-items: stretch;
  }
  .sam2-region-row.sam2-toggle-row {
    padding-top: 4px;
    border-top: 1px dashed rgba(255, 255, 255, 0.08);
  }
  .sam2-region-row.sam2-controls {
    padding-left: 16px;
  }
  .sam2-region-row.sam2-mode-row {
    gap: 4px;
    padding-left: 16px;
  }
  .sam2-mode {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 3px 8px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 4px;
    font-size: var(--text-micro);
    color: var(--text-secondary);
    cursor: pointer;
  }
  .sam2-mode input[type="radio"] { display: none; }
  .sam2-mode.active {
    background: rgba(255, 91, 20, 0.15);
    border-color: var(--accent);
    color: var(--text);
  }
  .sam2-text-input {
    flex: 1;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.1);
    color: var(--text);
    padding: 4px 8px;
    border-radius: 4px;
    font-size: var(--text-micro);
    font-family: inherit;
  }
  .sam2-text-input:focus {
    outline: none;
    border-color: var(--accent);
  }
  .sam2-status.inline {
    margin-left: auto;
    font-family: var(--font-mono);
    font-size: 10px;
  }
  .sam2-check {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: var(--text-micro);
    color: var(--text);
    cursor: pointer;
  }
  .sam2-check input[type="checkbox"] {
    width: 13px;
    height: 13px;
    accent-color: var(--accent);
  }

  /* RichText output on frame */
  .ov-rich {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-direction: column;
    overflow: hidden;
    word-break: break-word;
  }
  .ov-rich :global(span) { color: inherit; }
  .caret-blink {
    display: inline-block;
    margin-left: 2px;
    animation: caret-blink 1s steps(2, start) infinite;
    color: currentColor;
  }
  @keyframes caret-blink {
    0%, 50% { opacity: 1; }
    50.01%, 100% { opacity: 0; }
  }

  /* Typing-animation toggle in the panel */
  .typing-toggle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-top: 6px;
    padding: 4px 8px;
    background: rgba(255, 91, 20, 0.08);
    border: 1px solid rgba(255, 91, 20, 0.18);
    border-radius: 4px;
    font-size: var(--text-micro);
    color: var(--text);
    cursor: pointer;
  }
  .typing-toggle input[type="checkbox"] {
    width: 12px;
    height: 12px;
    accent-color: var(--accent);
  }
  .typing-rate {
    margin-left: auto;
    font-family: var(--font-mono);
    color: var(--accent);
    font-size: 10px;
  }

  /* Index pill : "Video 1", "Video 2" visible dans le sticky label */

  /* Inline mini-controls dans le track label de la timeline */
  .track-mini {
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 3px;
    color: var(--text);
    cursor: pointer;
    padding: 1px 5px;
    font-size: 10px;
    line-height: 1;
    margin-left: 2px;
  }
  .track-mini:hover:not(:disabled) { background: rgba(255, 255, 255, 0.12); }
  .track-mini:disabled { opacity: 0.35; cursor: not-allowed; }
  .track-mini.active { background: var(--accent); color: #fff; border-color: var(--accent); }
  .track-mini.run { color: var(--accent); }
  .track-mini.del {
    color: var(--text-tertiary);
    padding: 2px 4px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 18px;
  }
  .track-mini.del:hover { color: #ef4444; background: rgba(239, 68, 68, 0.1); border-color: rgba(239, 68, 68, 0.25); }
  .track-mini.del.armed {
    color: #fff;
    background: #ef4444;
    border-color: #ef4444;
    animation: del-pulse 0.6s ease-in-out infinite alternate;
  }
  .del-confirm {
    font-size: 12px;
    font-weight: 700;
    line-height: 1;
    color: #fff;
  }
  @keyframes del-pulse {
    from { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.4); }
    to   { box-shadow: 0 0 0 3px rgba(239, 68, 68, 0); }
  }
  .track-mini.upload { cursor: pointer; }
</style>
