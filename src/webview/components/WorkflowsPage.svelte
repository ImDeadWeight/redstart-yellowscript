<script lang="ts">
  // The account's workflows: saved instructions for a recurring task, kept on
  // the Nest (personal ones, then the organization's). Running one sends the
  // text Nest composes from its own copy; a workflow with inputs asks for
  // them first. Type `/` in the composer for the same list.
  import type { WorkflowView } from '../../chat/protocol.ts'
  import { post } from '../host.ts'
  import { view } from '../store.svelte.ts'
  import Page from './Page.svelte'
  import Icon from './Icon.svelte'

  let { items, error, focus }: { items: WorkflowView[] | null; error?: string | undefined; focus?: string | null } = $props()

  let openName: string | null = $state(null)
  let values: Record<string, string> = $state({})

  $effect(() => {
    if (focus) openName = focus
  })

  function start(workflow: WorkflowView) {
    if (workflow.arguments.length === 0) return run(workflow)
    openName = openName === workflow.name ? null : workflow.name
    values = {}
  }

  function run(workflow: WorkflowView) {
    const args: Record<string, string> = {}
    for (const a of workflow.arguments) {
      const v = values[a.name]?.trim()
      if (v) args[a.name] = v
    }
    post({ type: 'runWorkflow', name: workflow.name, args })
    openName = null
    values = {}
    view.closePage()
  }

  const ready = (w: WorkflowView) => w.arguments.every((a) => !a.required || !!values[a.name]?.trim())
</script>

<Page title="Workflows" subtitle="Saved instructions you run in the chat. Type / in the message box for the same list.">
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if items === null}
    <p class="muted"><Icon name="spinner" size={12} /> Loading workflows…</p>
  {:else if items.length === 0 && !error}
    <p class="muted">No workflows yet. Create them in the chat app's Workflows page.</p>
  {:else}
    {#each items as workflow (workflow.name)}
      {@const open = openName === workflow.name}
      <div class="item" class:open>
        <button type="button" class="head" aria-expanded={workflow.arguments.length ? open : undefined} onclick={() => start(workflow)}>
          <span class="body">
            <span class="title">{workflow.title}</span>
            <span class="slash">/{workflow.name}</span>
            {#if workflow.description}<span class="desc">{workflow.description}</span>{/if}
          </span>
          <span class="run">{workflow.arguments.length ? (open ? 'Close' : 'Fill in') : 'Run'}</span>
        </button>
        {#if open}
          <form class="inputs" onsubmit={(e) => { e.preventDefault(); if (ready(workflow)) run(workflow) }}>
            {#each workflow.arguments as arg (arg.name)}
              <label>
                <span>{arg.name.replace(/_/g, ' ')}{arg.required ? '' : ' (optional)'}</span>
                <textarea rows="2" placeholder={arg.description ?? ''} bind:value={values[arg.name]}></textarea>
              </label>
            {/each}
            <button type="submit" class="primary" disabled={!ready(workflow)}><Icon name="send" size={12} /> Run</button>
          </form>
        {/if}
      </div>
    {/each}
  {/if}
</Page>

<style>
  .item { border-radius: 6px; border: 1px solid var(--ys-card-border); background: var(--ys-card); }
  .item.open { border-color: var(--ys-accent-border); }
  .head {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    width: 100%;
    padding: 7px 8px;
    font: inherit;
    color: inherit;
    text-align: left;
    background: none;
    border: none;
    cursor: pointer;
  }
  .head:hover { background: var(--vscode-list-hoverBackground); border-radius: 6px; }
  .body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .title { font-weight: 600; }
  .slash { font-size: 0.82em; opacity: 0.6; font-family: var(--vscode-editor-font-family); }
  .desc { font-size: 0.88em; opacity: 0.75; overflow-wrap: anywhere; }
  .run { font-size: 0.85em; color: var(--vscode-textLink-foreground); white-space: nowrap; }
  .inputs { display: flex; flex-direction: column; gap: 8px; padding: 0 8px 8px; }
  label { display: flex; flex-direction: column; gap: 3px; font-size: 0.88em; }
  label span { opacity: 0.8; text-transform: capitalize; }
  textarea {
    resize: vertical;
    padding: 5px 8px;
    font: inherit;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 4px;
  }
  textarea:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .inputs .primary { align-self: flex-end; }
  .muted { display: flex; align-items: center; gap: 6px; margin: 0; opacity: 0.7; }
  .error { margin: 0; color: var(--vscode-errorForeground); }
</style>
