<script lang="ts">
  import type { AttachmentView, SessionSnapshot, WorkflowView } from '../../chat/protocol.ts'
  import { MAX_IMAGES, attachmentLabel } from '../../chat/attachments.ts'
  import { untrack } from 'svelte'
  import { post } from '../host.ts'
  import { draftFor, flushDraft, hasLocalDraft, setDraft } from '../drafts.ts'
  import { view } from '../store.svelte.ts'
  import { atQuery, composerPlaceholder, fitWithin, matchWorkflows, slashQuery, type ViewState } from '../view-model.ts'
  import Icon from './Icon.svelte'

  let { session, viewState }: { session: SessionSnapshot; viewState: ViewState } = $props()

  let text = $state('')
  let box: HTMLTextAreaElement | undefined = $state()
  let highlighted = $state(0)
  let dismissed = $state(false)
  /** Images, @files and selections going with the next message. */
  let attachments = $state<AttachmentView[]>([])
  /** Where the caret is, for the @ picker. */
  let caret = $state(0)
  let fileHighlighted = $state(0)
  let fileDismissed = $state(false)

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
  const fileMenuOpen = $derived(fileQuery !== null && !fileDismissed)
  $effect(() => {
    if (fileQuery !== null) post({ type: 'searchFiles', query: fileQuery })
  })
  $effect(() => {
    void fileQuery
    fileHighlighted = 0
  })
  $effect(() => {
    if (fileQuery === null) fileDismissed = false
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

  /** An image file, downscaled to 1,280px at most, as a data URL. */
  async function readImage(file: File): Promise<AttachmentView | null> {
    const url = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(file)
    })
    const img = new Image()
    await new Promise((resolve, reject) => {
      img.onload = resolve
      img.onerror = reject
      img.src = url
    })
    const { width, height } = fitWithin(img.naturalWidth, img.naturalHeight)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    canvas.getContext('2d')?.drawImage(img, 0, 0, width, height)
    // PNG keeps a small screenshot sharp; anything bigger goes as JPEG.
    const dataUrl = file.type === 'image/png' && width * height <= 600_000 ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.85)
    return { kind: 'image', name: file.name || 'pasted image', dataUrl }
  }

  async function addImages(files: readonly File[]) {
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue
      if (attachments.filter((a) => a.kind === 'image').length >= MAX_IMAGES) break
      const image = await readImage(file).catch(() => null)
      if (image) attachments = [...attachments, image]
    }
  }

  function onPaste(event: ClipboardEvent) {
    const files = [...(event.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'))
    if (files.length === 0) return
    event.preventDefault()
    void addImages(files)
  }

  function onDrop(event: DragEvent) {
    const files = [...(event.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/'))
    if (files.length === 0) return
    event.preventDefault()
    void addImages(files)
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
    if (fileMenuOpen && fileMatches && fileMatches.length > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        fileHighlighted = (fileHighlighted + (event.key === 'ArrowDown' ? 1 : -1) + fileMatches.length) % fileMatches.length
        return
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
        event.preventDefault()
        const pick = fileMatches[fileHighlighted]
        if (pick) chooseFile(pick)
        return
      }
    }
    if (fileMenuOpen && event.key === 'Escape') {
      event.preventDefault()
      fileDismissed = true
      return
    }
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

<div class="composer" role="group" aria-label="Compose a message" ondragover={(e) => e.preventDefault()} ondrop={onDrop}>
  {#if fileMenuOpen}
    <div class="menu" role="listbox" aria-label="Files">
      {#if fileMatches === null}
        <div class="menu-note"><Icon name="spinner" size={12} /> Finding files…</div>
      {:else if fileMatches.length === 0}
        <div class="menu-note">No file matches.</div>
      {:else}
        {#each fileMatches as path, i (path)}
          <button
            type="button"
            class="option"
            class:active={i === fileHighlighted}
            role="option"
            aria-selected={i === fileHighlighted}
            onmouseenter={() => (fileHighlighted = i)}
            onclick={() => chooseFile(path)}
          >
            <span class="slash">@{path}</span>
          </button>
        {/each}
      {/if}
    </div>
  {:else if menuOpen}
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
  {#if attachments.length}
    <div class="attachments">
      {#each attachments as attachment, i (i)}
        <span class="attachment" title={attachment.kind === 'selection' ? attachment.text.slice(0, 400) : attachmentLabel(attachment)}>
          {#if attachment.kind === 'image'}
            <img src={attachment.dataUrl} alt={attachment.name} />
          {:else}
            <Icon name="file" size={12} />
          {/if}
          <span class="label">{attachmentLabel(attachment)}</span>
          <button type="button" class="remove" aria-label="Remove {attachmentLabel(attachment)}" onclick={() => removeAttachment(i)}>
            <Icon name="x" size={10} />
          </button>
        </span>
      {/each}
    </div>
    {#if imagesBlocked}
      <div class="note">This model cannot read images. Remove them to send, or load a model that can.</div>
    {/if}
  {/if}
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
  .attachments { display: flex; flex-wrap: wrap; gap: 4px; padding: 6px 6px 0; }
  .attachment {
    display: flex;
    align-items: center;
    gap: 4px;
    max-width: 100%;
    padding: 2px 4px 2px 6px;
    font-size: 0.8em;
    border: 1px solid var(--ys-card-border);
    border-radius: 10px;
    background: var(--ys-card);
  }
  .attachment img { width: 28px; height: 28px; object-fit: cover; border-radius: 4px; }
  .attachment .label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .remove { display: flex; padding: 2px; color: inherit; background: none; border: none; border-radius: 50%; cursor: pointer; opacity: 0.6; }
  .remove:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
  .note { padding: 4px 8px 0; font-size: 0.8em; color: var(--vscode-editorWarning-foreground); }
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
