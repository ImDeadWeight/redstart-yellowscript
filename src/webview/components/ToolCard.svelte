<script lang="ts">
  import type { ToolCardView } from '../../chat/protocol.ts'
  import { argumentsPreview } from '../view-model.ts'
  import Icon from './Icon.svelte'

  let { card }: { card: ToolCardView } = $props()
  let open = $state(false)

  /** ws_read_file → read file; Nest tools keep their name. */
  const label = $derived(card.name.startsWith('ws_') ? card.name.slice(3).replace(/_/g, ' ') : card.name.replace(/_/g, ' '))
  const preview = $derived(argumentsPreview(card.arguments))
  const pretty = $derived.by(() => {
    try {
      return JSON.stringify(JSON.parse(card.arguments || '{}'), null, 2)
    } catch {
      return card.arguments
    }
  })
  const onNest = $derived(!card.name.startsWith('ws_') && card.name !== 'ask_user' && card.name !== 'update_plan')
</script>

<div class="card {card.status}">
  <button type="button" class="head" aria-expanded={open} onclick={() => (open = !open)}>
    <span class="status">
      {#if card.status === 'running'}
        <Icon name="spinner" size={12} label="running" />
      {:else if card.status === 'error'}
        <Icon name="alert" size={12} label="failed" />
      {:else}
        <Icon name="check" size={12} label="done" />
      {/if}
    </span>
    <span class="name">{label}</span>
    {#if preview}<span class="args">{preview}</span>{/if}
    {#if onNest}<span class="tag" title="Runs on the Nest">Nest</span>{/if}
    {#if card.recovered}<span class="tag warn" title="The model wrote this call as text; Yellowscript recovered it">recovered</span>{/if}
    <Icon name={open ? 'chevron-up' : 'chevron-down'} size={12} />
  </button>
  {#if card.summary && !open}
    <div class="summary">{card.summary}{card.truncated ? ' (truncated)' : ''}</div>
  {/if}
  {#if open}
    <div class="detail">
      {#if pretty && pretty !== '{}'}<pre>{pretty}</pre>{/if}
      {#if card.summary}<div class="summary">{card.summary}{card.truncated ? ' (truncated)' : ''}</div>{/if}
    </div>
  {/if}
</div>

<style>
  .card {
    border-radius: 4px;
    font-size: 0.88em;
    background: var(--ys-card);
    border: 1px solid var(--ys-card-border);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 3px 6px;
    font: inherit;
    color: inherit;
    text-align: left;
    background: none;
    border: none;
    cursor: pointer;
  }
  .status { display: flex; opacity: 0.8; }
  .done .status { color: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); }
  .error .status { color: var(--vscode-errorForeground); }
  .name { font-weight: 600; white-space: nowrap; }
  .args {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    opacity: 0.7;
    font-family: var(--vscode-editor-font-family);
  }
  .tag {
    padding: 0 5px;
    border-radius: 3px;
    font-size: 0.85em;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
  }
  .tag.warn { background: var(--vscode-editorWarning-foreground); color: var(--vscode-editor-background); }
  .summary { padding: 0 8px 4px 24px; opacity: 0.7; overflow-wrap: anywhere; }
  .detail { padding: 0 6px 4px; }
  .detail .summary { padding: 4px 2px 0; }
  pre {
    margin: 0;
    padding: 6px 8px;
    max-height: 200px;
    overflow: auto;
    border-radius: 3px;
    font-family: var(--vscode-editor-font-family);
    font-size: 0.95em;
    background: var(--vscode-textCodeBlock-background);
  }
</style>
