<script lang="ts">
  import type { SessionSnapshot } from '../../chat/protocol.ts'
  import { post } from '../host.ts'
  import { composerPlaceholder, type ViewState } from '../view-model.ts'
  import Icon from './Icon.svelte'

  let { session, viewState }: { session: SessionSnapshot; viewState: ViewState } = $props()

  let text = $state('')
  let box: HTMLTextAreaElement | undefined = $state()

  const placeholder = $derived(composerPlaceholder(viewState))

  function submit() {
    const value = text.trim()
    if (!value || !session.canSend) return
    post({ type: 'send', text: value })
    text = ''
    void Promise.resolve().then(resize)
  }

  function onKeydown(event: KeyboardEvent) {
    // Enter sends; Shift+Enter is a newline, like every chat the person knows.
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      submit()
    }
  }

  /** Grow with the text, up to a point. Set through the CSSOM: the CSP has no
   *  'unsafe-inline' for style attributes. */
  function resize() {
    if (!box) return
    box.style.height = 'auto'
    box.style.height = `${Math.min(box.scrollHeight, 200)}px`
  }
</script>

<div class="composer">
  <textarea
    bind:this={box}
    bind:value={text}
    rows="2"
    {placeholder}
    disabled={!session.canSend}
    aria-label="Message"
    oninput={resize}
    onkeydown={onKeydown}
  ></textarea>
  <div class="bar">
    <span class="model" title={session.serverUrl ?? ''}>
      {#if session.model}<Icon name="server" size={12} />{session.model}{/if}
    </span>
    {#if session.busy}
      <button type="button" class="secondary" onclick={() => post({ type: 'abort' })}>
        <Icon name="stop" size={12} />Stop
      </button>
    {/if}
    <button type="button" class="primary" disabled={!session.canSend || !text.trim()} onclick={submit}>
      <Icon name="send" size={12} />Send
    </button>
  </div>
</div>

<style>
  .composer {
    display: flex;
    flex-direction: column;
    border-radius: 6px;
    border: 1px solid var(--vscode-input-border, var(--ys-card-border));
    background: var(--vscode-input-background);
  }
  .composer:focus-within { border-color: var(--vscode-focusBorder); }
  textarea {
    width: 100%;
    min-height: 44px;
    max-height: 200px;
    resize: none;
    padding: 7px 9px 2px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-input-foreground);
    background: transparent;
    border: none;
    outline: none;
  }
  textarea:disabled { opacity: 0.6; }
  .bar { display: flex; align-items: center; gap: 6px; padding: 4px 6px 6px; }
  .model {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 4px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: 0.8em;
    opacity: 0.6;
  }
</style>
