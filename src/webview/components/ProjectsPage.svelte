<script lang="ts">
  // Link this workspace to one of the account's Nest projects. Chats stay in
  // the workspace; the project is what the Redstart apps share: its
  // instructions and memories reach the model on every request from here.
  import type { ProjectView } from '../../chat/protocol.ts'
  import { post } from '../host.ts'
  import Page from './Page.svelte'
  import Icon from './Icon.svelte'

  let { items, linkedId, error }: { items: ProjectView[] | null; linkedId: string | null; error?: string | undefined } = $props()

  let creating = $state(false)
  let name = $state('')

  function create(event: SubmitEvent) {
    event.preventDefault()
    const value = name.trim()
    if (!value) return
    post({ type: 'createProject', name: value })
    name = ''
    creating = false
  }

  const linked = $derived(items?.find((p) => p.id === linkedId) ?? null)
</script>

<Page title="Project" subtitle="Its instructions and memories go with every request from this workspace.">
  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  {#if items === null}
    <p class="muted"><Icon name="spinner" size={12} /> Loading projects…</p>
  {:else}
    <div class="list" role="radiogroup" aria-label="Project for this workspace">
      <button type="button" class="item" class:on={!linkedId} role="radio" aria-checked={!linkedId} onclick={() => post({ type: 'linkProject', id: null })}>
        <span class="mark">{#if !linkedId}<Icon name="check" size={12} />{/if}</span>
        <span class="body">
          <span class="name">No project</span>
          <span class="desc">Your own memories only.</span>
        </span>
      </button>
      {#each items as project (project.id)}
        {@const on = project.id === linkedId}
        <button type="button" class="item" class:on role="radio" aria-checked={on} onclick={() => post({ type: 'linkProject', id: project.id })}>
          <span class="mark">{#if on}<Icon name="check" size={12} />{/if}</span>
          <span class="body">
            <span class="name">{project.name}</span>
            {#if project.instructions}<span class="desc">{project.instructions}</span>{/if}
            {#if project.folder}<span class="folder">Documents/{project.folder}</span>{/if}
          </span>
        </button>
      {/each}
    </div>

    {#if items.length === 0 && !error}
      <p class="muted">No projects yet. Make one here, or in the chat app's sidebar.</p>
    {/if}

    {#if creating}
      <form class="create" onsubmit={create}>
        <!-- svelte-ignore a11y_autofocus -->
        <input placeholder="Project name" maxlength="80" bind:value={name} aria-label="Project name" autofocus />
        <button type="submit" class="primary" disabled={!name.trim()}>Create and link</button>
        <button type="button" class="secondary" onclick={() => (creating = false)}>Cancel</button>
      </form>
    {:else}
      <button type="button" class="link add" onclick={() => (creating = true)}><Icon name="plus" size={12} /> New project</button>
    {/if}

    {#if linked}
      <p class="muted small">Edit instructions and memories for "{linked.name}" in the chat app.</p>
    {/if}
  {/if}
</Page>

<style>
  .list { display: flex; flex-direction: column; gap: 4px; }
  .item {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    width: 100%;
    padding: 7px 8px;
    font: inherit;
    color: inherit;
    text-align: left;
    border-radius: 6px;
    border: 1px solid var(--ys-card-border);
    background: var(--ys-card);
    cursor: pointer;
  }
  .item:hover { background: var(--vscode-list-hoverBackground); }
  .item.on { border-color: var(--ys-accent); background: var(--ys-accent-faint); }
  .mark {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    margin-top: 2px;
    flex-shrink: 0;
    border-radius: 50%;
    border: 1px solid var(--vscode-descriptionForeground);
    color: var(--ys-accent);
  }
  .on .mark { border-color: var(--ys-accent); }
  .body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .name { font-weight: 600; }
  .desc { font-size: 0.88em; opacity: 0.75; overflow-wrap: anywhere; }
  .folder { font-size: 0.8em; opacity: 0.55; font-family: var(--vscode-editor-font-family); }
  .create { display: flex; flex-wrap: wrap; gap: 6px; }
  .create input {
    flex: 1 1 100%;
    padding: 5px 8px;
    font: inherit;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 4px;
  }
  .add { display: inline-flex; align-items: center; gap: 4px; align-self: flex-start; }
  .muted { display: flex; align-items: center; gap: 6px; margin: 0; opacity: 0.7; }
  .small { font-size: 0.85em; }
  .error { margin: 0; color: var(--vscode-errorForeground); }
</style>
