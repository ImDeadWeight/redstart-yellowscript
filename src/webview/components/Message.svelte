<script lang="ts">
  import type { ChatMessageView } from '../../chat/protocol.ts'
  import { renderMarkdown } from '../markdown.ts'
  import ToolCard from './ToolCard.svelte'
  import Icon from './Icon.svelte'

  let { message }: { message: ChatMessageView } = $props()

  // renderMarkdown escapes the whole input before emitting any tag of its own
  // (see markdown.ts): the only safe way to put model text into {@html}.
  const html = $derived(message.role === 'assistant' ? renderMarkdown(message.content) : '')
  const stats = $derived(message.stats)
  const working = $derived(message.streaming === true && !message.content && !(message.tools?.length))

  // A finished turn with many calls folds them into one row: on an agentic
  // turn the answer is what the person came for, not the twelve reads before it.
  const GROUP_AT = 4
  const tools = $derived(message.tools ?? [])
  const grouped = $derived(tools.length >= GROUP_AT && !message.streaming)
  const failed = $derived(tools.filter((t) => t.status === 'error').length)
  let showTools = $state(false)
</script>

<article class="message {message.role}" class:pending={message.pending} class:streaming={message.streaming}>
  {#if message.role === 'user'}
    <div class="bubble">{message.content}</div>
    {#if message.pending}<span class="note">Queued</span>{/if}
  {:else}
    {#if message.reasoning}
      <details class="reasoning">
        <summary>Thinking</summary>
        <div class="reasoning-body">{message.reasoning}</div>
      </details>
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
    {:else if working}
      <div class="working" aria-label="Working"><span></span><span></span><span></span></div>
    {/if}
    {#if message.error}
      <div class="error" role="alert">{message.error}</div>
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
  .note { font-size: 0.8em; opacity: 0.6; }
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
  .reasoning {
    font-size: 0.9em;
    border-left: 2px solid var(--vscode-panel-border, var(--vscode-widget-border));
    padding-left: 8px;
  }
  .reasoning summary { cursor: pointer; opacity: 0.65; user-select: none; }
  .reasoning-body { margin-top: 4px; white-space: pre-wrap; opacity: 0.75; max-height: 240px; overflow-y: auto; }
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
</style>
