<script lang="ts">
  import Icon from './Icon.svelte'

  /** The composer's paperclip: an image from disk, or a workspace file (the
   *  @ picker). Pasting and dropping images still work; this is the way you
   *  can see. */
  let {
    disabled = false,
    onImages,
    onWorkspaceFile,
  }: { disabled?: boolean; onImages: (files: File[]) => void; onWorkspaceFile: () => void } = $props()

  let open = $state(false)
  let input: HTMLInputElement | undefined = $state()
  let root: HTMLElement | undefined = $state()

  function pickImages() {
    open = false
    input?.click()
  }
  function pickFile() {
    open = false
    onWorkspaceFile()
  }
  function onChange() {
    const files = input?.files ? [...input.files] : []
    if (files.length) onImages(files)
    // The same file can be picked again after it was removed.
    if (input) input.value = ''
  }

  // Closed by a click elsewhere or Escape.
  $effect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (root && !root.contains(e.target as Node)) open = false
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') open = false
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  })
</script>

<span class="attach" bind:this={root}>
  <button
    type="button"
    class="icon-button"
    title="Attach an image or a file"
    aria-label="Attach"
    aria-haspopup="menu"
    aria-expanded={open}
    {disabled}
    onclick={() => (open = !open)}
  >
    <Icon name="paperclip" size={13} />
  </button>
  {#if open}
    <div class="popup" role="menu">
      <button type="button" role="menuitem" onclick={pickImages}><Icon name="image" size={12} />Image from disk…</button>
      <button type="button" role="menuitem" onclick={pickFile}><Icon name="file" size={12} />Workspace file… <kbd>@</kbd></button>
    </div>
  {/if}
  <input bind:this={input} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden onchange={onChange} />
</span>

<style>
  .attach { position: relative; display: flex; }
  .icon-button {
    display: flex;
    padding: 3px;
    color: inherit;
    background: none;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    opacity: 0.7;
  }
  .icon-button:hover:not(:disabled) { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
  .icon-button:disabled { opacity: 0.35; cursor: default; }
  .popup {
    position: absolute;
    left: 0;
    bottom: calc(100% + 4px);
    z-index: 6;
    display: flex;
    flex-direction: column;
    min-width: 180px;
    padding: 4px;
    border-radius: 6px;
    border: 1px solid var(--vscode-widget-border, var(--ys-card-border));
    background: var(--vscode-quickInput-background, var(--vscode-editorWidget-background, var(--vscode-editor-background)));
    box-shadow: 0 4px 16px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.3));
  }
  .popup button {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 8px;
    font: inherit;
    color: inherit;
    text-align: left;
    background: none;
    border: none;
    border-radius: 4px;
    cursor: pointer;
  }
  .popup button:hover { background: var(--vscode-list-hoverBackground); }
  kbd { margin-left: auto; opacity: 0.6; font-family: var(--vscode-editor-font-family); font-size: 0.9em; }
</style>
