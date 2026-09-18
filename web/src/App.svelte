<script lang="ts">
  import { onMount } from 'svelte';
  import VideoCompEditor from './VideoCompEditor.svelte';

  type Montage = { id: string; name?: string };
  let montages = $state<Montage[]>([]);
  let selected = $state('');
  let data = $state<unknown>(null);
  let loadingList = $state(true);
  let loadingEditor = $state(false);
  let listError = $state('');
  let editorError = $state('');
  let request: AbortController | undefined;

  async function selectMontage(id: string) {
    request?.abort();
    const current = new AbortController();
    request = current;
    selected = id;
    data = null;
    editorError = '';
    loadingEditor = true;
    try {
      const response = await fetch(`/api/comps/${encodeURIComponent(id)}`, { signal: current.signal });
      if (!response.ok) throw new Error(`Chargement impossible (HTTP ${response.status}).`);
      const body: unknown = await response.json();
      if (request !== current) return;
      // The API returns { id, output_assets } ; the editor expects the CONTENT of output_assets.
      // Passing it the envelope produces a timeline without video and “No video”.
      data = (body as { output_assets?: unknown } | null)?.output_assets ?? body;
    } catch (error) {
      if (current.signal.aborted) return;
      editorError = error instanceof Error ? error.message : 'Impossible de charger ce montage.';
    } finally {
      if (request === current) loadingEditor = false;
    }
  }

  onMount(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch('/api/comps', { signal: controller.signal });
        if (!response.ok) throw new Error(`Liste indisponible (HTTP ${response.status}).`);
        const body: unknown = await response.json();
        if (!Array.isArray(body) || !body.every(item =>
          item && typeof item === 'object' && typeof item.id === 'string')) {
          throw new Error('Invalid list response: an array of compositions with ids was expected.');
        }
        if (controller.signal.aborted) return;
        montages = body;
      } catch (error) {
        if (!controller.signal.aborted) {
          listError = error instanceof Error ? error.message : 'Impossible de charger les montages.';
        }
      } finally {
        if (!controller.signal.aborted) loadingList = false;
      }
    })();
    return () => { controller.abort(); request?.abort(); };
  });
</script>

<div class="atelier">
  <aside aria-label="Montages">
    <h1>Video Atelier</h1>
    {#if loadingList}
      <p role="status">Loading compositions…</p>
    {:else if listError}
      <p class="error" role="alert">{listError}</p>
    {:else if montages.length === 0}
      <p>No compositions yet.</p>
    {:else}
      <nav aria-label="Choisir un montage">
        {#each montages as montage (montage.id)}
          <button class:active={selected === montage.id}
            aria-current={selected === montage.id ? 'page' : undefined}
            onclick={() => selectMontage(montage.id)}>
            {montage.name || montage.id}
          </button>
        {/each}
      </nav>
    {/if}
  </aside>
  <main aria-label="Video editor" aria-busy={loadingEditor}>
    {#if loadingEditor}
      <p class="placeholder" role="status">Loading composition…</p>
    {:else if editorError}
      <div class="placeholder" role="alert">
        <p class="error">{editorError}</p>
        <button onclick={() => selectMontage(selected)}>Retry</button>
      </div>
    {:else if data !== null}
      {#key selected}
        <VideoCompEditor {data} metadata={{ step_trace_id: selected }} />
      {/key}
    {:else if !loadingList && !listError && montages.length === 0}
      <div class="placeholder">
        <h2>Nothing to edit yet</h2>
        <p>Create an edit with the agent, then reload this page to continue it here.</p>
      </div>
    {:else}
      <p class="placeholder">Pick a composition in the sidebar.</p>
    {/if}
  </main>
</div>

<style>
  .atelier { display: grid; grid-template-columns: 190px minmax(0, 1fr); min-height: 100vh; width: 100%; }
  aside { padding: 16px 10px; border-right: 1px solid var(--glass-border); background: var(--bg); min-width: 0; }
  h1 { font-size: 1rem; margin: 0 0 20px; }
  aside p { color: var(--text-secondary); overflow-wrap: anywhere; }
  nav { display: flex; flex-direction: column; gap: 6px; }
  button { border: 1px solid var(--glass-border); border-radius: var(--radius-sm); background: var(--bg); padding: 10px; cursor: pointer; }
  nav button { text-align: left; width: 100%; overflow-wrap: anywhere; }
  button:hover { background: var(--surface-hover); }
  button.active { background: var(--surface-active); border-color: var(--accent); }
  main { min-width: 0; width: 100%; }
  .placeholder { padding: 32px; color: var(--text-secondary); }
  .error { color: var(--error); }
  @media (max-width: 700px) { .atelier { grid-template-columns: 136px minmax(0, 1fr); } }
</style>
