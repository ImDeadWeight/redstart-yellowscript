<script lang="ts">
  // A tool call waiting for allow / deny: a command, a file write, or one of
  // Nest's tools. Sits above the composer like a question. The host decides
  // what the options mean; this only names the one the person clicked.
  import { untrack } from 'svelte'
  import type { ApprovalView } from '../../chat/protocol.ts'
  import { post } from '../host.ts'
  import Icon from './Icon.svelte'

  let { approval }: { approval: ApprovalView } = $props()

  /** Lines of a file's diff shown before "open in editor" takes over. */
  const DIFF_LINES = 300

  const icon = $derived(approval.kind === 'command' ? 'terminal' : approval.kind === 'write' ? 'file' : 'shield')
  // One file opens expanded; several start folded so the buttons stay in reach.
  // Reset only for a new request: a state update for the same one (the plan
  // changed, say) must not refold what the person opened.
  let open = $state<boolean[]>([])
  let deciding = $state(false)
  $effect(() => {
    void approval.id
    untrack(() => {
      const files = approval.files ?? []
      open = files.map(() => files.length === 1)
      deciding = false
    })
  })

  function choose(choice: string) {
    if (deciding) return
    deciding = true
    post({ type: 'approve', id: approval.id, choice })
  }

  function lines(diff: string) {
    const all = diff.replace(/\n$/, '').split('\n')
    return { shown: all.slice(0, DIFF_LINES), hidden: Math.max(0, all.length - DIFF_LINES) }
  }

  function kindOf(line: string): string {
    if (line.startsWith('+++') || line.startsWith('---')) return 'meta'
    if (line.startsWith('@@')) return 'hunk'
    if (line.startsWith('+')) return 'add'
    if (line.startsWith('-')) return 'del'
    return ''
  }

</script>

<section class="card" aria-label="Approval needed">
  <div class="head">
    <Icon name={icon} size={16} />
    <span class="title">{approval.title}</span>
    {#if approval.queued > 0}<span class="queued" title="{approval.queued} more waiting">+{approval.queued}</span>{/if}
  </div>

  {#if approval.kind === 'write'}
    <p class="label">{approval.subject}</p>
  {:else}
    <pre class="subject">{approval.subject}</pre>
  {/if}

  {#if approval.detail}
    <pre class="detail">{approval.detail}</pre>
  {/if}

  {#if approval.files?.length}
    <div class="files">
      {#each approval.files as file, i (`${approval.id}:${i}`)}
        <div class="file">
          <div class="file-head">
            <button type="button" class="toggle" aria-expanded={open[i]} onclick={() => (open[i] = !open[i])}>
              <Icon name={open[i] ? 'chevron-down' : 'chevron-right'} size={12} />
              <span class="badge {file.change}">{file.change}</span>
              <span class="path">{file.path}</span>
            </button>
            <button
              type="button"
              class="link"
              title="Open the diff in the editor"
              onclick={() => post({ type: 'openApprovalDiff', id: approval.id, index: i })}
            >Open diff</button>
          </div>
          {#if open[i]}
            {@const d = lines(file.diff)}
            <pre class="diff">{#each d.shown as line, n (n)}<span class={kindOf(line)}>{line || ' '}</span>
{/each}</pre>
            {#if d.hidden > 0}
              <p class="more">{d.hidden} more lines — open the diff to see them all.</p>
            {/if}
          {/if}
        </div>
      {/each}
    </div>
  {/if}

  <div class="row">
    {#each approval.options as option (option.id)}
      <button
        type="button"
        class={option.kind === 'allow' ? 'primary' : 'secondary'}
        class:deny={option.kind === 'deny'}
        disabled={deciding}
        onclick={() => choose(option.id)}
      >
        {#if option.kind === 'allow'}<Icon name="check" size={12} />{:else if option.kind === 'deny'}<Icon name="x" size={12} />{/if}
        {option.label}
      </button>
    {/each}
  </div>
</section>

<style>
  .card {
    padding: 10px;
    border-radius: 8px;
    border: 1px solid var(--ys-accent-border);
    background: var(--ys-card);
  }
  .head { display: flex; align-items: center; gap: 8px; font-weight: 600; }
  .head :global(.icon) { color: var(--ys-accent); flex-shrink: 0; }
  .title { flex: 1; min-width: 0; }
  .queued {
    padding: 0 6px;
    border-radius: 8px;
    font-size: 0.8em;
    font-weight: normal;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
  }
  .label { margin: 6px 0 0 24px; overflow-wrap: anywhere; }
  pre {
    margin: 8px 0 0;
    font-family: var(--vscode-editor-font-family);
    font-size: var(--vscode-editor-font-size, 0.9em);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .subject {
    padding: 6px 8px;
    border-radius: 4px;
    background: var(--vscode-textCodeBlock-background, var(--vscode-input-background));
    border: 1px solid var(--ys-card-border);
    max-height: 160px;
    overflow-y: auto;
  }
  .detail {
    font-family: inherit;
    font-size: 0.85em;
    opacity: 0.75;
    max-height: 180px;
    overflow-y: auto;
  }
  .files { display: flex; flex-direction: column; gap: 4px; margin-top: 8px; }
  .file { border: 1px solid var(--ys-card-border); border-radius: 6px; overflow: hidden; }
  .file-head { display: flex; align-items: center; gap: 4px; background: var(--vscode-input-background); }
  .toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    min-width: 0;
    padding: 5px 8px;
    font: inherit;
    color: inherit;
    background: none;
    border: none;
    text-align: left;
    cursor: pointer;
  }
  .path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .badge {
    flex-shrink: 0;
    padding: 0 5px;
    border-radius: 3px;
    font-size: 0.75em;
    text-transform: uppercase;
    border: 1px solid currentColor;
    opacity: 0.85;
  }
  .badge.create { color: var(--vscode-gitDecoration-addedResourceForeground, #73c991); }
  .badge.edit { color: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d); }
  .badge.delete { color: var(--vscode-gitDecoration-deletedResourceForeground, #c74e39); }
  .link {
    flex-shrink: 0;
    margin-right: 6px;
    padding: 2px 4px;
    font: inherit;
    font-size: 0.85em;
    color: var(--vscode-textLink-foreground);
    background: none;
    border: none;
    cursor: pointer;
  }
  .link:hover { text-decoration: underline; }
  .diff {
    margin: 0;
    padding: 4px 0;
    max-height: 280px;
    overflow: auto;
    white-space: pre;
    font-size: 0.85em;
    line-height: 1.4;
  }
  .diff span { display: block; padding: 0 8px; }
  .diff .add { background: var(--vscode-diffEditor-insertedLineBackground, rgba(155, 185, 85, 0.2)); }
  .diff .del { background: var(--vscode-diffEditor-removedLineBackground, rgba(255, 0, 0, 0.2)); }
  .diff .hunk { color: var(--vscode-descriptionForeground); }
  .diff .meta { display: none; }
  .more { margin: 0; padding: 4px 8px; font-size: 0.85em; opacity: 0.7; }
  .row { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; margin-top: 10px; }
  .row button { display: inline-flex; align-items: center; gap: 4px; }
  .deny { order: -1; margin-right: auto; }
</style>
