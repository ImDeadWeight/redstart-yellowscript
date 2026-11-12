<script lang="ts">
  import type { SessionSnapshot, WorkflowView } from '../../chat/protocol.ts'
  import { post } from '../host.ts'
  import { view } from '../store.svelte.ts'
  import { composerPlaceholder, matchWorkflows, slashQuery, type ViewState } from '../view-model.ts'
  import Icon from './Icon.svelte'

  let { session, viewState }: { session: SessionSnapshot; viewState: ViewState } = $props()

  let text = $state('')
  let box: HTMLTextAreaElement | undefined = $state()
  let highlighted = $state(0)
  let dismissed = $state(false)

  const placeholder = $derived(composerPlaceholder(viewState))

  // `/` at the start of an empty message lists workflows (Nest's, as MCP
  // prompts). Loaded on first use; the list stays until the next load.
  const query = $derived(slashQuery(text))
  const workflows = $derived(viewState.workflows.items)
  const matches = $derived(query !== null && workflows ? matchWorkflows(workflows, query) : [])
  const menuOpen = $derived(query !== null && !dismissed)

  $effect(() => {
    if (query !== null && workflows === null) post({ type: 'loadPage', page: 'workflows' })
  })
  $effect(() => {
    void query
    highlighted = 0
  })
  $effect(() => {
    if (query === null) dismissed = false
  })

  function choose(workflow: WorkflowView) {
    text = ''
    if (workflow.arguments.length === 0) {
      post({ type: 'runWorkflow', name: workflow.name, args: {} })
      return
    }
    // Inputs to fill: the Workflows page has the form.
    view.workflowFocus = workflow.name
    view.openPage('workflows')
  }

  function submit() {
    const value = text.trim()
    if (!value || !session.canSend) return
    post({ type: 'send', text: value })
    text = ''
    void Promise.resolve().then(resize)
  }

  function onKeydown(event: KeyboardEvent) {
    if (menuOpen && matches.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        highlighted = (highlighted + 1) % matches.length
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        highlighted = (highlighted - 1 + matches.length) % matches.length
        return
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
        event.preventDefault()
        const pick = matches[highlighted]
        if (pick) choose(pick)
        return
      }
    }
    if (menuOpen && event.key === 'Escape') {
      event.preventDefault()
      dismissed = true
      return
    }
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

  function openProjects() {
    view.openPage('projects')
    post({ type: 'loadPage', page: 'projects' })
  }
</script>

<div class="composer">
  {#if menuOpen}
    <div class="menu" role="listbox" aria-label="Workflows">
      {#if workflows === null}
        <div class="menu-note"><Icon name="spinner" size={12} /> Loading workflows…</div>
      {:else if matches.length === 0}
        <div class="menu-note">
          {workflows.length === 0 ? 'No workflows yet. Create them in the chat app.' : 'No workflow matches.'}
        </div>
      {:else}
        {#each matches as workflow, i (workflow.name)}
          <button
            type="button"
            class="option"
            class:active={i === highlighted}
            role="option"
            aria-selected={i === highlighted}
            onmouseenter={() => (highlighted = i)}
            onclick={() => choose(workflow)}
          >
            <span class="slash">/{workflow.name}</span>
            <span class="title">{workflow.title}{workflow.arguments.length ? '…' : ''}</span>
          </button>
        {/each}
      {/if}
    </div>
  {/if}
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
    <button
      type="button"
      class="chip"
      class:linked={!!session.project}
      title={session.project ? `Project: ${session.project.name}. Click to change.` : 'Link this workspace to a Nest project'}
      onclick={openProjects}
    >
      <Icon name="folder" size={12} />
      <span>{session.project ? session.project.name : 'No project'}</span>
    </button>
    <span class="model" title={session.serverUrl ?? ''}>{session.model ?? ''}</span>
    {#if session.busy}
      <button type="button" class="secondary" onclick={() => post({ type: 'abort' })}>
        <Icon name="stop" size={12} />Stop
      </button>
    {/if}
    <button type="button" class="primary" disabled={!session.canSend || !text.trim() || query !== null} onclick={submit}>
      <Icon name="send" size={12} />Send
    </button>
  </div>
</div>

<style>
  .composer {
    position: relative;
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
  .chip {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    max-width: 55%;
    padding: 2px 6px;
    font: inherit;
    font-size: 0.8em;
    color: inherit;
    background: none;
    border: 1px solid var(--ys-card-border);
    border-radius: 10px;
    cursor: pointer;
    opacity: 0.7;
  }
  .chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chip:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
  .chip.linked { opacity: 1; border-color: var(--ys-accent-border); }
  .chip.linked :global(.icon) { color: var(--ys-accent); }
  .model {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: 0.8em;
    opacity: 0.5;
  }
  .menu {
    position: absolute;
    left: 0;
    right: 0;
    bottom: calc(100% + 4px);
    max-height: 220px;
    overflow-y: auto;
    padding: 4px;
    z-index: 5;
    border-radius: 6px;
    border: 1px solid var(--vscode-widget-border, var(--ys-card-border));
    background: var(--vscode-quickInput-background, var(--vscode-editorWidget-background));
    box-shadow: 0 4px 16px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.3));
  }
  .option {
    display: flex;
    align-items: baseline;
    gap: 8px;
    width: 100%;
    padding: 5px 8px;
    font: inherit;
    color: inherit;
    text-align: left;
    background: none;
    border: none;
    border-radius: 4px;
    cursor: pointer;
  }
  .option.active {
    background: var(--vscode-list-activeSelectionBackground, var(--vscode-list-hoverBackground));
    color: var(--vscode-list-activeSelectionForeground, inherit);
  }
  .slash { font-family: var(--vscode-editor-font-family); font-size: 0.9em; }
  .title { opacity: 0.7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .menu-note { display: flex; align-items: center; gap: 6px; padding: 6px 8px; opacity: 0.7; }
</style>
