<script lang="ts">
  import type { ToolCardView } from '../../chat/protocol.ts'
  import { argumentsPreview, commandView } from '../view-model.ts'
  import Icon from './Icon.svelte'

  let { card }: { card: ToolCardView } = $props()
  let open = $state(false)

  /** ys_read_file → read file; Nest tools keep their name. */
  const label = $derived(card.name.startsWith('ys_') ? card.name.slice(3).replace(/_/g, ' ') : card.name.replace(/_/g, ' '))
  const preview = $derived(argumentsPreview(card.arguments))
  /** A write's arguments can be a whole file. Laying out tens of kilobytes on
   *  every streamed update is what made an opened card tear; the start is
   *  enough to see what the call was. */
  const SHOWN_CHARS = 4_000
  const pretty = $derived.by(() => {
    let text: string
    try {
      text = JSON.stringify(JSON.parse(card.arguments || '{}'), null, 2)
    } catch {
      text = card.arguments
    }
    return text.length > SHOWN_CHARS ? `${text.slice(0, SHOWN_CHARS)}
… ${(text.length - SHOWN_CHARS).toLocaleString()} more characters` : text
  })
  /** Commands get a terminal view: the line in, how it ended, what it printed. */
  const command = $derived(commandView(card))
  const rejected = $derived(/ — rejected$/.test(card.summary ?? ''))
  /** "Exit code 0 · 1.2s" → "exit 0 · 1.2s"; anything else, its start. */
  const chip = $derived.by(() => {
    if (rejected) return 'denied'
    const status = command?.status
    if (!status) return null
    const exit = /^Exit code (-?\d+) · ([\d.]+s)/.exec(status)
    if (exit) return `exit ${exit[1]} · ${exit[2]}`
    return status.length > 48 ? `${status.slice(0, 47)}…` : status
  })
  const CLOSED_LINES = 6
  const outputLines = $derived(command?.output ? command.output.split('\n') : [])
  const shownOutput = $derived(
    open || outputLines.length <= CLOSED_LINES ? (command?.output ?? '') : outputLines.slice(-CLOSED_LINES).join('\n'),
  )
  const onNest = $derived(!card.name.startsWith('ys_') && card.name !== 'ask_user' && card.name !== 'update_plan')
</script>

{#if command}
<div class="card command {card.status}" class:rejected>
  <button type="button" class="head" aria-expanded={open} onclick={() => (open = !open)}>
    <span class="status">
      {#if card.status === 'running'}
        <Icon name="spinner" size={12} label="running" />
      {:else if card.status === 'error'}
        <Icon name="alert" size={12} label="failed" />
      {:else}
        <Icon name="terminal" size={12} label="done" />
      {/if}
    </span>
    {#if command.read}
      <span class="cmd read">{command.command}</span>
    {:else}
      <span class="prompt" aria-hidden="true">$</span><code class="cmd">{command.command}</code>
    {/if}
    {#if command.background}<span class="tag" title="Runs in the background">background</span>{/if}
    {#if chip}<span class="exit" title={command.status ?? card.summary ?? ''}>{chip}</span>{/if}
    <Icon name={open ? 'chevron-up' : 'chevron-down'} size={12} />
  </button>
  {#if open && (command.cwd || card.summary)}
    <div class="meta">
      {#if command.cwd}<span>in {command.cwd}</span>{/if}
      {#if card.summary}<span>{card.summary}</span>{/if}
    </div>
  {/if}
  {#if card.status === 'running'}
    <div class="running">{command.background ? 'Starting…' : 'Running…'}</div>
  {:else if shownOutput}
    <pre class="out" class:clipped={!open && outputLines.length > CLOSED_LINES}>{shownOutput}</pre>
  {:else if !rejected && command.status}
    <div class="running">No output.</div>
  {/if}
</div>
{:else}
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
{/if}

<style>
  .card {
    /* Opening or updating one card repaints that card, not the transcript. */
    contain: layout paint;
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
  /* Commands: the line in, a chip for how it ended, the output below. */
  .prompt { opacity: 0.55; font-family: var(--vscode-editor-font-family); }
  .cmd {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--vscode-editor-font-family);
    background: none;
    padding: 0;
  }
  .cmd.read { font-family: inherit; opacity: 0.8; }
  .done .status { color: var(--vscode-terminal-ansiGreen, var(--vscode-charts-green)); }
  .exit {
    padding: 0 5px;
    border-radius: 3px;
    font-size: 0.85em;
    white-space: nowrap;
    font-family: var(--vscode-editor-font-family);
    border: 1px solid var(--ys-card-border);
  }
  .error .exit { color: var(--vscode-errorForeground); border-color: var(--vscode-errorForeground); }
  .rejected { opacity: 0.6; }
  .meta { display: flex; flex-wrap: wrap; gap: 2px 10px; padding: 0 8px 4px 24px; font-size: 0.92em; opacity: 0.65; }
  .running { padding: 0 8px 4px 24px; opacity: 0.6; font-style: italic; }
  .out {
    margin: 0 6px 6px;
    padding: 5px 8px;
    max-height: 300px;
    overflow: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    border-radius: 3px;
    font-family: var(--vscode-editor-font-family);
    font-size: 0.95em;
    color: var(--vscode-terminal-foreground, inherit);
    background: var(--vscode-terminal-background, var(--vscode-textCodeBlock-background));
  }
  /* Closed: the last lines, fading in from the top. */
  .out.clipped { -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 1.4em); mask-image: linear-gradient(to bottom, transparent 0, #000 1.4em); }
</style>
