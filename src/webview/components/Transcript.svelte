<script lang="ts">
  import { tick, untrack } from 'svelte'
  import type { ChatMessageView } from '../../chat/protocol.ts'
  import type { Notice } from '../view-model.ts'
  import { view } from '../store.svelte.ts'
  import Message from './Message.svelte'
  import Icon from './Icon.svelte'
  import { latestTaskId } from '../view-model.ts'

  let { messages, notices, generation, paused = false }: { messages: ChatMessageView[]; notices: Notice[]; generation: number; /** Waiting on the person (approval, question, turn limit), not the model. */ paused?: boolean } = $props()

  const latest = $derived(latestTaskId(messages))

  let scroller: HTMLDivElement | undefined = $state()

  // Following the stream is the person's choice, not something worked out
  // from where the scrollbar happens to sit. Only something they did detaches
  // it (wheel or keys upward, grabbing the scrollbar, pressing into the text
  // to select it), and only they re-attach it, by reaching the bottom
  // themselves or pressing "Jump to latest". New output never moves the view
  // while detached, and a scroll in progress is never fought.
  let following = $state(true)
  /** New output arrived while detached. */
  let unseen = $state(false)
  /** A pointer is down in the transcript (dragging the scrollbar, selecting). */
  let holding = false
  let frame = 0

  const AT_BOTTOM_PX = 24
  function atBottom(): boolean {
    return !!scroller && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < AT_BOTTOM_PX
  }

  function detach() {
    following = false
  }

  function reattach() {
    following = true
    unseen = false
  }

  function onWheel(event: WheelEvent) {
    if (event.deltaY < 0) detach()
  }

  function onKeydown(event: KeyboardEvent) {
    if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) detach()
  }

  function onPointerDown() {
    holding = true
    detach()
  }

  function onPointerUp() {
    if (!holding) return
    holding = false
    if (atBottom()) reattach()
  }

  // Our own jumps land at the bottom, so this only ever re-attaches.
  function onScroll() {
    if (!following && !holding && atBottom()) reattach()
  }

  function toBottom() {
    cancelAnimationFrame(frame)
    // One jump per frame however many deltas arrive in it.
    frame = requestAnimationFrame(() => {
      if (scroller && following && !holding) scroller.scrollTop = scroller.scrollHeight
    })
  }

  function jumpToLatest() {
    reattach()
    void tick().then(toBottom)
  }

  // A replaced transcript (init, tab switch) always opens at the end. Only a
  // new generation does this: the follow state it writes is untracked, so
  // scrolling up (which changes that state) can never re-run it. It did, and
  // every scroll up was undone on the spot, running or stopped.
  let seenGeneration = -1
  $effect(() => {
    const current = generation
    if (current === seenGeneration) return
    seenGeneration = current
    untrack(() => {
      reattach()
      void tick().then(toBottom)
    })
  })

  // New output: follow it, or note it for "Jump to latest". Depends on the
  // transcript only, never on the follow state.
  $effect(() => {
    void messages
    void notices.length
    untrack(() => {
      if (!following) {
        unseen = true
        return
      }
      void tick().then(toBottom)
    })
  })
</script>

<svelte:window onpointerup={onPointerUp} onpointercancel={onPointerUp} />

<div class="wrap">
<!-- The listeners only read what the person does to scroll; the log itself
     stays a non-interactive region. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="transcript"
  bind:this={scroller}
  onscroll={onScroll}
  onwheel={onWheel}
  onkeydown={onKeydown}
  onpointerdown={onPointerDown}
  role="log"
  aria-live="polite"
  tabindex="-1"
>
  {#if messages.length === 0}
    <div class="empty">
      <p class="hello">Ask about this workspace, or ask for a change.</p>
      <p class="hint">Yellowscript reads files, searches, and checks diagnostics. Edits and commands wait for your approval.</p>
    </div>
  {/if}
  {#each messages as message (message.id)}
    <Message {message} latestTask={message.id === latest} {paused} />
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
{#if !following && unseen}
  <button type="button" class="latest" onclick={jumpToLatest}>
    <Icon name="chevron-down" size={12} />Jump to latest
  </button>
{/if}
</div>

<style>
  .wrap {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .transcript {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    /* The browser's own scroll anchoring stays off: it fought the jump to
       the bottom, and switching it as following changed cancelled a wheel
       scroll part way through. Following is ours alone. */
    overflow-anchor: none;
    outline: none;
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
  .latest {
    position: absolute;
    bottom: 8px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 3px 10px;
    font: inherit;
    font-size: 0.85em;
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
    border: none;
    border-radius: 12px;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
    cursor: pointer;
  }
  .latest:hover { background: var(--vscode-button-hoverBackground); }
  .dismiss:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
</style>
