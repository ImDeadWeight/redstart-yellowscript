<script lang="ts">
  // A page that takes over the panel (Projects, Workflows): a header with a
  // way back to the chat, and the page's own content below it.
  import type { Snippet } from 'svelte'
  import { view } from '../store.svelte.ts'
  import Icon from './Icon.svelte'

  let { title, subtitle, children }: { title: string; subtitle?: string; children: Snippet } = $props()

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') view.closePage()
  }
</script>

<svelte:window onkeydown={onKeydown} />

<section class="page" aria-label={title}>
  <header>
    <button type="button" class="icon-button" aria-label="Back to the chat" title="Back to the chat" onclick={() => view.closePage()}>
      <Icon name="chevron-right" size={14} />
    </button>
    <div class="titles">
      <h2>{title}</h2>
      {#if subtitle}<p>{subtitle}</p>{/if}
    </div>
  </header>
  <div class="content">{@render children()}</div>
</section>

<style>
  .page { display: flex; flex-direction: column; flex: 1; min-height: 0; }
  header {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    padding: 10px 10px 8px 6px;
    border-bottom: 1px solid var(--vscode-panel-border, transparent);
  }
  header :global(.icon-button .icon) { transform: rotate(180deg); }
  .titles { min-width: 0; }
  h2 { margin: 2px 0 0; font-size: 1.05em; font-weight: 600; }
  p { margin: 2px 0 0; font-size: 0.88em; opacity: 0.7; }
  .content { flex: 1; min-height: 0; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 10px; }
</style>
