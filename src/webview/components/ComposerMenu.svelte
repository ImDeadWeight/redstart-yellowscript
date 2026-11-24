<script lang="ts" generics="T">
  // The composer's pop-up list: the `/` workflows and the `@` files. Open while
  // `query` is not null and the person has not pressed Escape on it; arrows
  // move the highlight, Enter or Tab chooses. The composer forwards its key
  // presses through keydown().
  import type { Snippet } from 'svelte'
  import Icon from './Icon.svelte'

  let {
    query,
    items,
    label,
    loadingNote,
    emptyNote,
    key,
    onChoose,
    option,
  }: {
    /** What was typed after the trigger; null: the menu is closed. */
    query: string | null
    /** The matches; null while they load. */
    items: readonly T[] | null
    label: string
    loadingNote: string
    emptyNote: string
    key: (item: T) => string
    onChoose: (item: T) => void
    option: Snippet<[T]>
  } = $props()

  let highlighted = $state(0)
  let dismissed = $state(false)
  const open = $derived(query !== null && !dismissed)

  $effect(() => {
    void query
    highlighted = 0
  })
  $effect(() => {
    if (query === null) dismissed = false
  })

  /** Show it again after Escape, as when the trigger is typed for the person. */
  export function reopen(): void {
    dismissed = false
  }

  /** A key pressed in the composer. True when the menu took it. */
  export function keydown(event: KeyboardEvent): boolean {
    if (!open) return false
    if (items && items.length > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        highlighted = (highlighted + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
        return true
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
        event.preventDefault()
        const pick = items[highlighted]
        if (pick !== undefined) onChoose(pick)
        return true
      }
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      dismissed = true
      return true
    }
    return false
  }
</script>

{#if open}
  <div class="menu" role="listbox" aria-label={label}>
    {#if items === null}
      <div class="menu-note"><Icon name="spinner" size={12} /> {loadingNote}</div>
    {:else if items.length === 0}
      <div class="menu-note">{emptyNote}</div>
    {:else}
      {#each items as item, i (key(item))}
        <button
          type="button"
          class="option"
          class:active={i === highlighted}
          role="option"
          aria-selected={i === highlighted}
          onmouseenter={() => (highlighted = i)}
          onclick={() => onChoose(item)}
        >
          {@render option(item)}
        </button>
      {/each}
    {/if}
  </div>
{/if}

<style>
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
    background: var(--vscode-quickInput-background, var(--vscode-editorWidget-background, var(--vscode-editor-background)));
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
  .menu-note { display: flex; align-items: center; gap: 6px; padding: 6px 8px; opacity: 0.7; }
</style>
