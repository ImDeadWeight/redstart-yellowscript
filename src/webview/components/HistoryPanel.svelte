<script lang="ts">
  import type { HistoryItem } from '../view-model.ts'
  import { post } from '../host.ts'
  import { view } from '../store.svelte.ts'
  import Icon from './Icon.svelte'

  let { items }: { items: HistoryItem[] } = $props()

  let query = $state('')
  let timer: ReturnType<typeof setTimeout> | undefined
  let panel: HTMLDivElement | undefined = $state()

  function search() {
    clearTimeout(timer)
    timer = setTimeout(() => post({ type: 'searchHistory', query }), 150)
  }

  function onWindowClick(event: MouseEvent) {
    if (panel && !panel.contains(event.target as Node)) view.closeHistory()
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') view.closeHistory()
  }

  const when = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
</script>

<svelte:window onclickcapture={onWindowClick} onkeydown={onKeydown} />

<div class="panel" bind:this={panel} role="dialog" aria-label="Conversation history">
  <!-- svelte-ignore a11y_autofocus -->
  <input class="search" type="search" placeholder="Search history…" bind:value={query} oninput={search} autofocus />
  <div class="list">
    {#each items as item (item.id)}
      <div class="row">
        <button type="button" class="open" onclick={() => post({ type: 'restoreHistory', id: item.id })}>
          <span class="title">{item.title || 'Untitled'}</span>
          <span class="meta">{when(item.lastAccessedAt)} · {item.messageCount} messages</span>
        </button>
        <button
          type="button"
          class="delete"
          title="Delete from history"
          aria-label="Delete {item.title || 'Untitled'}"
          onclick={() => post({ type: 'deleteHistory', id: item.id })}
        ><Icon name="x" size={12} /></button>
      </div>
    {:else}
      <p class="empty">{query ? 'No matches' : 'No history yet'}</p>
    {/each}
  </div>
</div>

<style>
  .panel {
    position: absolute;
    top: 34px;
    right: 6px;
    left: 6px;
    max-width: 360px;
    margin-left: auto;
    max-height: 60vh;
    display: flex;
    flex-direction: column;
    z-index: 10;
    border-radius: 6px;
    border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
    background: var(--vscode-quickInput-background, var(--vscode-editorWidget-background));
    box-shadow: 0 4px 16px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.3));
    overflow: hidden;
  }
  .search {
    margin: 6px;
    padding: 5px 8px;
    font: inherit;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 4px;
  }
  .search:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .list { overflow-y: auto; padding: 0 4px 4px; }
  .row { display: flex; align-items: center; border-radius: 4px; }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .open {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 5px 8px;
    text-align: left;
    font: inherit;
    color: inherit;
    background: none;
    border: none;
    cursor: pointer;
  }
  .title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta { font-size: 0.85em; opacity: 0.65; }
  .delete {
    display: flex;
    padding: 4px;
    margin-right: 4px;
    color: inherit;
    background: none;
    border: none;
    border-radius: 3px;
    cursor: pointer;
    opacity: 0;
  }
  .row:hover .delete, .delete:focus-visible { opacity: 0.8; }
  .delete:hover { background: var(--vscode-toolbar-hoverBackground); }
  .empty { margin: 8px; opacity: 0.65; text-align: center; }
</style>
