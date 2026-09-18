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
      // L'API répond { id, output_assets } ; l'éditeur attend le CONTENU d'output_assets.
      // Lui passer l'enveloppe donne une timeline sans vidéo et « Aucune video ».
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
          throw new Error('Réponse de liste invalide : un tableau de montages avec id est attendu.');
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
      <p role="status">Chargement des montages…</p>
    {:else if listError}
      <p class="error" role="alert">{listError}</p>
    {:else if montages.length === 0}
      <p>Aucun montage disponible.</p>
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
  <main aria-label="Éditeur vidéo" aria-busy={loadingEditor}>
    {#if loadingEditor}
      <p class="placeholder" role="status">Chargement du montage…</p>
    {:else if editorError}
      <div class="placeholder" role="alert">
        <p class="error">{editorError}</p>
        <button onclick={() => selectMontage(selected)}>Réessayer</button>
      </div>
    {:else if data !== null}
      {#key selected}
        <VideoCompEditor {data} metadata={{ step_trace_id: selected }} />
      {/key}
    {:else if !loadingList && !listError && montages.length === 0}
      <div class="placeholder">
        <h2>Aucun montage pour le moment</h2>
        <p>Créez un montage avec l’agent, puis rechargez cette page pour le reprendre ici.</p>
      </div>
    {:else}
      <p class="placeholder">Choisissez un montage dans la barre latérale.</p>
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
