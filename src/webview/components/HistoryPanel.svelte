<script lang="ts">
  import type { HistoryItem } from '../view-model.ts'
  import { post } from '../host.ts'
  import { view } from '../store.svelte.ts'
  import Icon from './Icon.svelte'

  let { items }: { items: HistoryItem[] } = $props()

  let query = $state('')
  let timer: ReturnType<typeof setTimeout> | undefined
  let panel: HTMLDivElement | undefined = $state()
  /** The row asking "delete this?". Deleting is permanent, so it is asked inline
   *  (a webview cannot open a confirm dialog). */
  let confirming: string | null = $state(null)

  function warning(item: HistoryItem): string {
    if (item.running) return 'It is still running: deleting stops the run and closes its tab.'
    if (item.open) return 'It is open in a tab, which will close.'
    return 'This cannot be undone.'
  }

  function search() {
    clearTimeout(timer)
    timer = setTimeout(() => post({ type: 'searchHistory', query }), 150)
  }

  function onWindowClick(event: MouseEvent) {
    if (panel && !panel.contains(event.target as Node)) view.closeHistory()
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape') return
    if (confirming) confirming = null
    else view.closeHistory()
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
        <button
          type="button"
          class="open"
          onclick={() => {
            view.closeHistory()
            post({ type: 'restoreHistory', id: item.id })
          }}
        >
          <span class="title">{item.title || 'Untitled'}</span>
          <span class="meta">{when(item.lastAccessedAt)} · {item.draft ? 'Draft' : `${item.messageCount} messages`}{#if item.open} · <span class="badge">Open</span>{/if}</span>
        </button>
        <button
          type="button"
          class="delete"
          title="Delete chat"
          aria-label="Delete {item.title || 'Untitled'}"
          onclick={() => (confirming = confirming === item.id ? null : item.id)}
        ><Icon name="x" size={12} /></button>
      </div>
      {#if confirming === item.id}
        <div class="confirm" role="alertdialog" aria-label="Delete {item.title || 'Untitled'}?">
          <Icon name="alert" size={12} />
          <span class="warning">Delete this chat permanently? {warning(item)}</span>
          <div class="actions">
            <button
              type="button"
              class="danger"
              onclick={() => {
                confirming = null
                post({ type: 'deleteHistory', id: item.id })
              }}
            >Delete</button>
            <button type="button" class="secondary" onclick={() => (confirming = null)}>Cancel</button>
          </div>
        </div>
      {/if}
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
  .confirm {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 6px;
    margin: 0 6px 6px;
    padding: 6px 8px;
    border-radius: 4px;
    font-size: 0.88em;
    border-left: 2px solid var(--vscode-editorWarning-foreground);
    background: var(--vscode-inputValidation-warningBackground, var(--vscode-textBlockQuote-background));
  }
  .confirm :global(.icon) { margin-top: 2px; color: var(--vscode-editorWarning-foreground); }
  .warning { flex: 1; min-width: 160px; }
  .actions { display: flex; gap: 6px; margin-left: auto; }
  .danger {
    padding: 2px 10px;
    font: inherit;
    color: var(--vscode-button-foreground);
    background: var(--vscode-errorForeground);
    border: none;
    border-radius: 3px;
    cursor: pointer;
  }
  .badge {
    padding: 0 5px;
    border-radius: 8px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
  }
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
