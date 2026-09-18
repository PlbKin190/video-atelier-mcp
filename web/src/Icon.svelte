<!--
  The original editor sourced its icons from an entire Studio library. It only uses
  three : Film, Mic and Music, on track headers. We redraw them here, which avoids
  porting the library and keeps the three calls unchanged.
-->
<script lang="ts">
  let { name, size = 14 }: { name: string; size?: number } = $props();
  const traces: Record<string, string> = {
    Film: 'M2.5 3.5h11v9h-11z M2.5 6h11 M2.5 10h11 M5.5 3.5v9 M10.5 3.5v9',
    Mic: 'M8 2.5a1.75 1.75 0 0 1 1.75 1.75v3.5a1.75 1.75 0 1 1-3.5 0v-3.5A1.75 1.75 0 0 1 8 2.5z M4.5 7.5a3.5 3.5 0 0 0 7 0 M8 11.5v2',
    Music: 'M6 12V4l6.5-1.25v8 M6 12a1.75 1.75 0 1 1-3.5 0 1.75 1.75 0 0 1 3.5 0z M12.5 10.75a1.75 1.75 0 1 1-3.5 0 1.75 1.75 0 0 1 3.5 0z'
  };
</script>

<svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor"
     stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d={traces[name] ?? ''} />
</svg>
