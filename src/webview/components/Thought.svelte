<script lang="ts">
  import Icon from './Icon.svelte'

  /** One stretch of the model's reasoning: a row that opens. While it is the
   *  live part, the row shows the latest line so you can see where it is. */
  let { text, live = false }: { text: string; live?: boolean } = $props()

  let open = $state(false)
  // Built only while open: as it streams only the last paragraph changes.
  const paragraphs = $derived(open ? text.split(/\n{2,}/) : [])
  /** The last non-empty line, for the closed row. */
  const latest = $derived.by(() => {
    if (!live) return ''
    // Only the end: a reasoning loop can run to hundreds of kilobytes.
    const lines = text.slice(-1_000).trimEnd().split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!.trim()
      if (line) return line.length > 140 ? `…${line.slice(-139)}` : line
    }
    return ''
  })
  /** Counted once the thought is over, not on every token. */
  const words = $derived(live ? 0 : (text.match(/\S+/g)?.length ?? 0))

  /** The open box keeps to its end while you are there, and stays put once
   *  you scroll up inside it. */
  function followOwnEnd(node: HTMLElement) {
    let stick = true
    const onScroll = () => {
      stick = node.scrollHeight - node.scrollTop - node.clientHeight < 16
    }
    node.addEventListener('scroll', onScroll, { passive: true })
    const observer = new MutationObserver(() => {
      if (stick) node.scrollTop = node.scrollHeight
    })
    observer.observe(node, { childList: true, subtree: true, characterData: true })
    node.scrollTop = node.scrollHeight
    return {
      destroy() {
        node.removeEventListener('scroll', onScroll)
        observer.disconnect()
      },
    }
  }
</script>

<div class="thought" class:live>
  <button type="button" class="row" aria-expanded={open} onclick={() => (open = !open)}>
    <Icon name={open ? 'chevron-down' : 'chevron-right'} size={11} />
    <span class="label">{live ? 'Thinking' : 'Thought'}</span>
    {#if !open}
      {#if live && latest}
        <span class="latest">{latest}</span>
      {:else}
        <span class="size">{words.toLocaleString()} words</span>
      {/if}
    {/if}
  </button>
  {#if open}
    <div class="body" use:followOwnEnd>
      {#each paragraphs as paragraph, i (i)}<p>{paragraph}</p>{/each}
    </div>
  {/if}
</div>

<style>
  .thought { font-size: 0.88em; min-width: 0; }
  .row {
    display: flex;
    align-items: center;
    gap: 5px;
    width: 100%;
    min-width: 0;
    padding: 1px 2px;
    font: inherit;
    color: inherit;
    text-align: left;
    background: none;
    border: none;
    border-radius: 3px;
    cursor: pointer;
    opacity: 0.6;
  }
  .row:hover { opacity: 0.95; background: var(--vscode-toolbar-hoverBackground); }
  .label { font-style: italic; white-space: nowrap; }
  .live .label { animation: pulse 1.6s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: 0.45; } }
  @media (prefers-reduced-motion: reduce) { .live .label { animation: none; } }
  .latest, .size {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    opacity: 0.8;
  }
  .body {
    margin: 2px 0 4px 6px;
    padding-left: 8px;
    border-left: 2px solid var(--vscode-panel-border, var(--vscode-widget-border));
    white-space: pre-wrap;
    opacity: 0.75;
    max-height: 240px;
    overflow-y: auto;
    /* Its own scroll: reaching its end does not carry on into the transcript. */
    overscroll-behavior: contain;
    contain: content;
  }
  .body p { margin: 0 0 0.6em; }
  .body p:last-child { margin-bottom: 0; }
</style>
