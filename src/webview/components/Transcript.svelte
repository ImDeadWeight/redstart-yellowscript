<script lang="ts">
  import { tick } from 'svelte'
  import type { ChatMessageView } from '../../chat/protocol.ts'
  import type { Notice } from '../view-model.ts'
  import { view } from '../store.svelte.ts'
  import Message from './Message.svelte'
  import Icon from './Icon.svelte'

  let { messages, notices, generation }: { messages: ChatMessageView[]; notices: Notice[]; generation: number } = $props()

  let scroller: HTMLDivElement | undefined = $state()
  /** Follow new output only while the person is at the bottom: yanking the
   *  view down while they read earlier output is worse than not following. */
  let following = true

  function onScroll() {
    if (!scroller) return
    following = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80
  }

  // A replaced transcript (init, tab switch) always opens at the end.
  $effect(() => {
    void generation
    following = true
  })

  $effect(() => {
    // Track everything that grows the transcript.
    void messages
    void notices.length
    if (!following) return
    void tick().then(() => {
      if (scroller) scroller.scrollTop = scroller.scrollHeight
    })
  })
</script>

<div class="transcript" bind:this={scroller} onscroll={onScroll} role="log" aria-live="polite">
  {#if messages.length === 0}
    <div class="empty">
      <p class="hello">Ask about this workspace, or ask for a change.</p>
      <p class="hint">Yellowscript reads files, searches, and checks diagnostics. Edits and commands wait for your approval.</p>
    </div>
  {/if}
  {#each messages as message (message.id)}
    <Message {message} />
  {/each}
  {#each notices as notice (notice.id)}
    <div class="notice {notice.level}" role={notice.level === 'error' ? 'alert' : 'status'}>
      <Icon name={notice.level === 'info' ? 'question' : 'alert'} />
      <span>{notice.message}</span>
      <button type="button" class="dismiss" aria-label="Dismiss" onclick={() => view.dismissNotice(notice.id)}>
        <Icon name="x" size={12} />
      </button>
    </div>
  {/each}
</div>

<style>
  .transcript {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 12px 12px 4px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .empty {
    margin: auto 8px;
    text-align: center;
    opacity: 0.75;
  }
  .hello { margin: 0 0 4px; font-weight: 600; }
  .hint { margin: 0; font-size: 0.9em; opacity: 0.8; }
  .notice {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    padding: 6px 8px;
    border-radius: 4px;
    font-size: 0.9em;
    border-left: 2px solid var(--vscode-textLink-foreground);
    background: var(--vscode-textBlockQuote-background);
  }
  .notice.warning { border-left-color: var(--vscode-editorWarning-foreground); }
  .notice.error { border-left-color: var(--vscode-errorForeground); }
  .notice span { flex: 1; }
  .notice :global(.icon) { margin-top: 2px; }
  .dismiss {
    display: flex;
    padding: 2px;
    color: inherit;
    background: none;
    border: none;
    border-radius: 3px;
    cursor: pointer;
    opacity: 0.6;
  }
  .dismiss:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
</style>
