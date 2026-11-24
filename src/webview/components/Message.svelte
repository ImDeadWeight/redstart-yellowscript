<script lang="ts">
  import type { ChatMessageView, ToolCardView } from '../../chat/protocol.ts'
  import { renderMarkdown } from '../markdown.ts'
  import ToolCard from './ToolCard.svelte'
  import TaskSummary from './TaskSummary.svelte'
  import Thought from './Thought.svelte'
  import Markdown from './Markdown.svelte'
  import { taskSummary } from '../../chat/run-log.ts'
  import { attachmentLabel } from '../../chat/attachments.ts'
  import { splitAnswer, turnBlocks, type TurnBlock } from '../../chat/turn-parts.ts'
  import { waitingNote } from '../view-model.ts'
  import Icon from './Icon.svelte'

  let { message, latestTask = false, paused = false }: { message: ChatMessageView; latestTask?: boolean; paused?: boolean } = $props()

  // --- Turns saved before `parts` existed: drawn from the flat fields. ---
  let renderedFrom: string | null = null
  let rendered = ''
  const html = $derived.by(() => {
    if (message.parts) return ''
    const content = message.role === 'assistant' ? message.content : ''
    if (content !== renderedFrom) {
      renderedFrom = content
      rendered = content ? renderMarkdown(content) : ''
    }
    return rendered
  })
  const GROUP_AT = 4
  const tools = $derived(message.tools ?? [])
  const grouped = $derived(tools.length >= GROUP_AT && !message.streaming)
  let showTools = $state(false)

  // --- The timeline: the turn in the order it happened. ---
  const cards = $derived(new Map<string, ToolCardView>(tools.map((t) => [t.callId, t])))
  const blocks = $derived(message.parts ? turnBlocks(message.parts) : [])
  const failed = $derived(tools.filter((t) => t.status === 'error').length)

  /** A finished turn: the work folds into one row, the answer stays open. */
  const split = $derived(message.streaming ? null : splitAnswer(blocks))
  const folded = $derived(split !== null && split.work.some((b) => b.kind === 'tools'))
  let showWork = $state(false)
  const steps = $derived(split ? split.work.filter((b) => b.kind === 'tools').length : 0)

  /** A live turn: the latest few blocks, the earlier ones behind a row. */
  const LIVE_SHOWN = 4
  let showEarlier = $state(false)
  const hiddenLive = $derived(message.streaming && !showEarlier ? Math.max(0, blocks.length - LIVE_SHOWN) : 0)
  const liveBlocks = $derived(hiddenLive ? blocks.slice(hiddenLive) : blocks)
  const lastKey = $derived(blocks[blocks.length - 1]?.key)

  const stats = $derived(message.stats)
  const summary = $derived(message.streaming ? null : taskSummary(message.run))

  // --- What a quiet stream is waiting on. ---
  // Activity is anything arriving: text, a thought, a call, a result.
  const activity = $derived(
    `${message.content.length}:${message.reasoning?.length ?? 0}:${tools.length}:${tools.filter((t) => t.status !== 'running').length}`,
  )
  let lastActivity = $state(Date.now())
  let now = $state(Date.now())
  // A pause (an approval, a question, the turn limit) ending counts too:
  // the clock is for the model, not for the person.
  $effect(() => {
    void activity
    void paused
    lastActivity = Date.now()
  })
  $effect(() => {
    if (!message.streaming) return
    const timer = setInterval(() => (now = Date.now()), 1_000)
    return () => clearInterval(timer)
  })
  const lastPart = $derived(message.parts?.[message.parts.length - 1])
  const toolRunning = $derived(tools.some((t) => t.status === 'running'))
  const waiting = $derived(
    message.streaming && !paused && !toolRunning ? waitingNote(now - lastActivity, lastPart?.kind === 'tool') : null,
  )
  const empty = $derived(message.streaming === true && blocks.length === 0 && !message.content && !tools.length)
</script>

<article class="message {message.role}" class:pending={message.pending} class:streaming={message.streaming}>
  {#if message.role === 'user'}
    {#if message.workflow}
      <details class="bubble workflow">
        <summary><Icon name="bolt" size={12} />{message.workflow.title}</summary>
        <div class="workflow-text">{message.content}</div>
      </details>
    {:else if message.content}
      <div class="bubble">{message.content}</div>
    {/if}
    {#if message.attachments?.length}
      <div class="attached">
        {#each message.attachments as attachment, i (i)}
          {#if attachment.kind === 'image'}
            <img class="thumb" src={attachment.dataUrl} alt={attachment.name} title={attachment.name} />
          {:else}
            <span class="chip" title={attachment.kind === 'file' && attachment.outline ? 'Sent as its outline: the file is long' : ''}>
              <Icon name="file" size={11} />{attachmentLabel(attachment)}
            </span>
          {/if}
        {/each}
      </div>
    {/if}
    {#if message.pending}<span class="note">Queued</span>{/if}
  {:else if message.parts}
    {#snippet block(b: TurnBlock, inAnswer: boolean)}
      {#if b.kind === 'reasoning'}
        <Thought text={b.text} live={message.streaming === true && b.key === lastKey} />
      {:else if b.kind === 'text'}
        <Markdown text={b.text} narration={!inAnswer} cursor={message.streaming === true && b.key === lastKey} />
      {:else if b.kind === 'notice'}
        <p class="notice" role="status"><Icon name="refresh" size={12} /><span>{b.text}</span></p>
      {:else}
        <div class="tools">
          {#each b.callIds as id (id)}
            {@const card = cards.get(id)}
            {#if card}<ToolCard {card} />{/if}
          {/each}
        </div>
      {/if}
    {/snippet}
    {#if split}
      {#if folded}
        <button type="button" class="group" aria-expanded={showWork} onclick={() => (showWork = !showWork)}>
          <Icon name={showWork ? 'chevron-down' : 'chevron-right'} size={12} />
          Worked through {steps} step{steps === 1 ? '' : 's'} · {tools.length} tool{tools.length === 1 ? '' : 's'}{failed ? `, ${failed} failed` : ''}
        </button>
        {#if showWork}
          <div class="work">
            {#each split.work as b (b.key)}{@render block(b, false)}{/each}
          </div>
        {/if}
      {:else}
        {#each split.work as b (b.key)}{@render block(b, false)}{/each}
      {/if}
      {#each split.answer as b (b.key)}{@render block(b, true)}{/each}
    {:else}
      {#if hiddenLive}
        <button type="button" class="group" onclick={() => (showEarlier = true)}>
          <Icon name="chevron-right" size={12} />
          {hiddenLive} earlier step{hiddenLive === 1 ? '' : 's'}
        </button>
      {/if}
      {#each liveBlocks as b (b.key)}{@render block(b, true)}{/each}
    {/if}
    {#if empty}
      <div class="working" aria-label="Working"><span></span><span></span><span></span></div>
    {/if}
    {#if waiting}
      <div class="waiting" role="status"><Icon name="spinner" size={11} />{waiting}</div>
    {/if}
  {:else}
    {#if message.reasoning}
      <Thought text={message.reasoning} live={message.streaming === true && !message.content} />
    {/if}
    {#if tools.length}
      <div class="tools">
        {#if grouped}
          <button type="button" class="group" aria-expanded={showTools} onclick={() => (showTools = !showTools)}>
            <Icon name={showTools ? 'chevron-down' : 'chevron-right'} size={12} />
            Used {tools.length} tools{failed ? `, ${failed} failed` : ''}
          </button>
        {/if}
        {#if !grouped || showTools}
          {#each tools as card (card.callId)}
            <ToolCard {card} />
          {/each}
        {/if}
      </div>
    {/if}
    {#if message.content}
      <div class="body">{@html html}</div>
    {:else if empty}
      <div class="working" aria-label="Working"><span></span><span></span><span></span></div>
    {/if}
  {/if}
  {#if message.role === 'assistant'}
    {#if message.error}
      <div class="error" role="alert">{message.error}</div>
    {/if}
    {#if summary}
      <TaskSummary turnId={message.id} {summary} canRevert={latestTask} />
    {/if}
    {#if message.aborted || stats?.tokensPerSecond}
      <footer>
        {#if message.aborted}<span>Stopped</span>{/if}
        {#if stats?.tokensPerSecond}
          <span>{stats.tokensPerSecond.toFixed(1)} tok/s</span>
          {#if stats.completionTokens}<span>{stats.completionTokens} tokens</span>{/if}
          <!-- 'length' means the model ran out of room: say so, or it looks like an arbitrary cut. -->
          {#if stats.finishReason === 'length'}<span class="warn">hit the length limit</span>{/if}
        {/if}
      </footer>
    {/if}
  {/if}
</article>

<style>
  .message {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .message.user { align-items: flex-end; }
  .bubble {
    max-width: 92%;
    padding: 6px 10px;
    border-radius: 10px 10px 2px 10px;
    white-space: pre-wrap;
    background: var(--ys-user-bubble);
    border: 1px solid var(--ys-user-bubble-border);
  }
  .pending .bubble { opacity: 0.55; font-style: italic; }
  .workflow { white-space: normal; }
  .workflow summary { display: flex; align-items: center; gap: 5px; cursor: pointer; font-weight: 600; }
  .workflow summary :global(.icon) { color: var(--ys-accent); }
  .workflow-text { margin-top: 6px; white-space: pre-wrap; font-size: 0.9em; opacity: 0.8; max-height: 200px; overflow-y: auto; }
  .note { font-size: 0.8em; opacity: 0.6; }
  .attached { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 4px; max-width: 92%; }
  .thumb { height: 60px; max-width: 120px; object-fit: cover; border-radius: 6px; border: 1px solid var(--ys-card-border); }
  .attached .chip {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 1px 7px;
    font-size: 0.8em;
    border-radius: 10px;
    border: 1px solid var(--ys-user-bubble-border);
    background: var(--ys-user-bubble);
  }
  .tools { display: flex; flex-direction: column; gap: 3px; }
  .group {
    display: flex;
    align-items: center;
    gap: 4px;
    align-self: flex-start;
    padding: 2px 4px;
    font: inherit;
    font-size: 0.88em;
    color: inherit;
    background: none;
    border: none;
    border-radius: 3px;
    cursor: pointer;
    opacity: 0.7;
  }
  .group:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
  .work {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding-left: 8px;
    border-left: 2px solid var(--vscode-panel-border, var(--vscode-widget-border));
  }
  .waiting { display: flex; align-items: center; gap: 6px; font-size: 0.85em; opacity: 0.6; }
  .streaming .body > :global(:last-child)::after {
    content: '▍';
    animation: blink 1s steps(2, start) infinite;
    opacity: 0.7;
  }
  @keyframes blink { to { visibility: hidden; } }
  @media (prefers-reduced-motion: reduce) {
    .streaming .body > :global(:last-child)::after { animation: none; }
    .working span { animation: none; }
  }
  .working { display: flex; gap: 4px; padding: 4px 0; }
  .working span {
    width: 5px; height: 5px; border-radius: 50%;
    background: currentColor;
    opacity: 0.3;
    animation: dot 1.2s ease-in-out infinite;
  }
  .working span:nth-child(2) { animation-delay: 0.15s; }
  .working span:nth-child(3) { animation-delay: 0.3s; }
  @keyframes dot { 30% { opacity: 0.9; } }
  .error {
    padding: 6px 8px;
    border-radius: 4px;
    color: var(--vscode-errorForeground);
    background: var(--vscode-inputValidation-errorBackground, transparent);
    border: 1px solid var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground));
  }
  footer { display: flex; flex-wrap: wrap; gap: 4px 10px; font-size: 0.8em; opacity: 0.55; }
  .warn { color: var(--vscode-editorWarning-foreground); opacity: 1; }
  /* A line about the run itself: a stagnation recovery. */
  .notice {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    margin: 2px 0;
    padding: 4px 8px;
    font-size: 0.86em;
    border-left: 2px solid var(--ys-accent);
    border-radius: 0 4px 4px 0;
    background: var(--ys-accent-faint);
  }
  .notice :global(.icon) { flex-shrink: 0; margin-top: 2px; color: var(--ys-accent-text); }
</style>
