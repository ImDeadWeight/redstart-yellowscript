<script lang="ts">
  import type { AttachmentView, SessionSnapshot, WorkflowView } from '../../chat/protocol.ts'
  import { untrack } from 'svelte'
  import { post } from '../host.ts'
  import { draftFor, flushDraft, hasLocalDraft, setDraft } from '../drafts.ts'
  import { view } from '../store.svelte.ts'
  import { atQuery, composerPlaceholder, matchWorkflows, slashQuery, type ViewState } from '../view-model.ts'
  import { imageFiles, withImages } from '../images.ts'
  import Icon from './Icon.svelte'
  import AttachmentChips from './AttachmentChips.svelte'
  import AttachButton from './AttachButton.svelte'
  import ContextMeter from './ContextMeter.svelte'
  import ComposerMenu from './ComposerMenu.svelte'

  let { session, viewState }: { session: SessionSnapshot; viewState: ViewState } = $props()

  let text = $state('')
  let box: HTMLTextAreaElement | undefined = $state()
  /** The `/` and `@` menus, which take the keys they use. */
  type Menu = { keydown(event: KeyboardEvent): boolean; reopen(): void }
  let workflowMenu: Menu | undefined = $state()
  let fileMenu: Menu | undefined = $state()
  /** Images, @files and selections going with the next message. */
  let attachments = $state<AttachmentView[]>([])
  /** Where the caret is, for the @ picker. */
  let caret = $state(0)

  const placeholder = $derived(composerPlaceholder(viewState))

  // Each tab keeps its own unsent text (see drafts.ts). Load it when the
  // active conversation changes, or when the host's copy arrives after the
  // composer mounted with nothing.
  let draftId: string | null = null
  $effect(() => {
    const id = viewState.conversationId
    const fromHost = viewState.tabs.find((t) => t.id === id)?.draft
    if (!id) return
    untrack(() => {
      if (id !== draftId) {
        draftId = id
        text = draftFor(id, fromHost)
        void Promise.resolve().then(resize)
      } else if (!text && fromHost && !hasLocalDraft(id)) {
        text = fromHost
        void Promise.resolve().then(resize)
      }
    })
  })
  $effect(() => {
    const value = text
    untrack(() => {
      if (draftId) setDraft(draftId, value)
    })
  })
  // Leaving for a page unmounts the composer: send the draft now.
  $effect(() => () => flushDraft())

  // `/` at the start of an empty message lists workflows (Nest's, as MCP
  // prompts). Loaded on first use; the list stays until the next load.
  const query = $derived(slashQuery(text))
  const workflows = $derived(viewState.workflows.items)
  const matches = $derived(query !== null && workflows ? matchWorkflows(workflows, query) : [])

  $effect(() => {
    if (query !== null && workflows === null) post({ type: 'loadPage', page: 'workflows' })
  })

  // Chips the host sent (the editor's "Add to Yellowscript").
  $effect(() => {
    if (viewState.inbox.length === 0) return
    untrack(() => {
      attachments = [...attachments, ...view.takeInbox()]
    })
  })

  // `@` then part of a path: workspace files to attach.
  const fileQuery = $derived(query === null ? atQuery(text.slice(0, caret)) : null)
  const fileMatches = $derived(fileQuery !== null && viewState.fileMatches?.query === fileQuery ? viewState.fileMatches.paths : null)
  $effect(() => {
    if (fileQuery !== null) post({ type: 'searchFiles', query: fileQuery })
  })

  function chooseFile(path: string) {
    // The typed "@query" becomes the chip.
    const before = text.slice(0, caret).replace(/@[^\s@]*$/, '')
    text = before + text.slice(caret)
    caret = before.length
    if (!attachments.some((a) => a.kind === 'file' && a.path === path)) attachments = [...attachments, { kind: 'file', path }]
    void Promise.resolve().then(() => {
      box?.focus()
      box?.setSelectionRange(caret, caret)
    })
  }

  function removeAttachment(index: number) {
    attachments = attachments.filter((_, i) => i !== index)
  }

  const imageCount = $derived(attachments.filter((a) => a.kind === 'image').length)
  /** The model cannot read images: say so instead of sending them. */
  const imagesBlocked = $derived(session.vision === false && imageCount > 0)

  async function addImages(files: readonly File[]) {
    attachments = await withImages(attachments, files)
  }

  function onPaste(event: ClipboardEvent) {
    const files = imageFiles(event.clipboardData?.files)
    if (files.length === 0) return
    event.preventDefault()
    void addImages(files)
  }

  function onDrop(event: DragEvent) {
    const files = imageFiles(event.dataTransfer?.files)
    if (files.length === 0) return
    event.preventDefault()
    void addImages(files)
  }

  /** The paperclip's "Workspace file…": type the @ that opens the picker. */
  function startFilePick() {
    const at = box?.selectionStart ?? text.length
    const before = text.slice(0, at)
    const insert = before && !/\s$/.test(before) ? ' @' : '@'
    text = before + insert + text.slice(at)
    caret = before.length + insert.length
    fileMenu?.reopen()
    void Promise.resolve().then(() => {
      resize()
      box?.focus()
      box?.setSelectionRange(caret, caret)
    })
  }

  function trackCaret() {
    if (box) caret = box.selectionStart ?? text.length
  }

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
    if ((!value && attachments.length === 0) || !session.canSend || imagesBlocked) return
    post(attachments.length ? { type: 'send', text: value, attachments: $state.snapshot(attachments) } : { type: 'send', text: value })
    text = ''
    attachments = []
    void Promise.resolve().then(resize)
  }

  function onKeydown(event: KeyboardEvent) {
    // An open menu takes the arrows, Enter, Tab and Escape.
    if (fileMenu?.keydown(event) || workflowMenu?.keydown(event)) return
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

<div class="composer" role="group" aria-label="Compose a message" ondragover={(e) => e.preventDefault()} ondrop={onDrop}>
  <!-- At most one is open: the @ menu only looks for a query when there is no / one. -->
  <ComposerMenu
    bind:this={fileMenu}
    query={fileQuery}
    items={fileMatches}
    label="Files"
    loadingNote="Finding files…"
    emptyNote="No file matches."
    key={(path) => path}
    onChoose={chooseFile}
  >
    {#snippet option(path)}
      <span class="slash">@{path}</span>
    {/snippet}
  </ComposerMenu>
  <ComposerMenu
    bind:this={workflowMenu}
    {query}
    items={workflows === null ? null : matches}
    label="Workflows"
    loadingNote="Loading workflows…"
    emptyNote={workflows?.length === 0 ? 'No workflows yet. Create them in the chat app.' : 'No workflow matches.'}
    key={(workflow) => workflow.name}
    onChoose={choose}
  >
    {#snippet option(workflow)}
      <span class="slash">/{workflow.name}</span>
      <span class="title">{workflow.title}{workflow.arguments.length ? '…' : ''}</span>
    {/snippet}
  </ComposerMenu>
  <AttachmentChips {attachments} {imagesBlocked} onRemove={removeAttachment} />
  <textarea
    bind:this={box}
    bind:value={text}
    rows="2"
    {placeholder}
    disabled={!session.canSend}
    aria-label="Message"
    oninput={() => {
      resize()
      trackCaret()
    }}
    onkeyup={trackCaret}
    onclick={trackCaret}
    onkeydown={onKeydown}
    onpaste={onPaste}
  ></textarea>
  <div class="bar">
    <AttachButton disabled={!session.canSend} onImages={(files) => void addImages(files)} onWorkspaceFile={startFilePick} />
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
    <ContextMeter usage={viewState.conversation.context} />
    {#if session.busy}
      <button type="button" class="secondary" onclick={() => post({ type: 'abort' })}>
        <Icon name="stop" size={12} />Stop
      </button>
    {/if}
    <button type="button" class="primary" disabled={!session.canSend || (!text.trim() && attachments.length === 0) || query !== null || imagesBlocked} onclick={submit}>
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
  .composer:focus-within { border-color: var(--ys-accent-border); }
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
  .slash { font-family: var(--vscode-editor-font-family); font-size: 0.9em; }
  .title { opacity: 0.7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
