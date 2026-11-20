<script lang="ts">
  // What a run changed, under its answer: the files (each opens its diff
  // since the run began), the commands with their exit codes, the processes
  // it started. Drawn from the turn's stored run, so a reloaded panel draws it
  // again. Revert is offered on the newest such card only: undoing an older
  // task would also undo every later change to the same files.
  import type { TaskSummaryView } from '../../chat/run-log.ts'
  import { post } from '../host.ts'
  import Icon from './Icon.svelte'

  let { turnId, summary, canRevert }: { turnId: string; summary: TaskSummaryView; canRevert: boolean } = $props()

  const fileCount = $derived(summary.files.length + summary.moves.length)
</script>

<section class="summary" aria-label="What this task changed">
  {#if fileCount}
    <div class="group">
      <span class="heading"><Icon name="file" size={12} />{fileCount} file{fileCount === 1 ? '' : 's'} changed</span>
      <ul>
        {#each summary.files as file (file.path)}
          <li>
            <button type="button" class="link" title="Open the diff since the task began" onclick={() => post({ type: 'openTaskDiff', turnId, path: file.path })}>
              {file.path}
            </button>
            <span class="tag {file.change}">{file.change}</span>
          </li>
        {/each}
        {#each summary.moves as move (move.to)}
          <li>
            <button type="button" class="link" title="Open the diff since the task began" onclick={() => post({ type: 'openTaskDiff', turnId, path: move.to })}>
              {move.from} → {move.to}
            </button>
            <span class="tag">moved</span>
          </li>
        {/each}
      </ul>
    </div>
  {/if}
  {#if summary.rejectedFiles.length}
    <div class="group muted">Not written (rejected): {summary.rejectedFiles.join(', ')}</div>
  {/if}
  {#if summary.commands.length}
    <div class="group">
      <span class="heading"><Icon name="terminal" size={12} />Commands</span>
      <ul>
        {#each summary.commands as command, i (i)}
          <li>
            <code>{command.command}</code>
            {#if command.rejected}
              <span class="tag">not run</span>
            {:else}
              <span class="tag" class:failed={command.failed}>{command.exitCode === null ? 'no exit code' : `exit ${command.exitCode}`}</span>
            {/if}
          </li>
        {/each}
      </ul>
    </div>
  {/if}
  {#if summary.processes.length}
    <div class="group">
      <span class="heading"><Icon name="server" size={12} />Started</span>
      <ul>
        {#each summary.processes as proc (proc.id)}
          <li>
            <code>{proc.id} {proc.command}</code>
            {#if proc.exited !== undefined}
              <span class="tag failed">exited {proc.exited}</span>
            {:else if proc.url}
              <span class="tag">{proc.url}</span>
            {/if}
          </li>
        {/each}
      </ul>
    </div>
  {/if}
  {#if canRevert && summary.revertible}
    <div class="actions">
      <button type="button" class="revert" onclick={() => post({ type: 'revertTask', turnId })}>
        <Icon name="refresh" size={12} />Revert this task
      </button>
    </div>
  {/if}
</section>

<style>
  .summary {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 6px 8px;
    font-size: 0.88em;
    border-radius: 4px;
    background: var(--ys-card);
    border: 1px solid var(--ys-card-border);
  }
  .heading { display: flex; align-items: center; gap: 5px; font-weight: 600; }
  ul { list-style: none; margin: 3px 0 0; padding: 0 0 0 17px; display: flex; flex-direction: column; gap: 2px; }
  li { display: flex; align-items: center; gap: 6px; min-width: 0; }
  code { font-family: var(--vscode-editor-font-family); font-size: 0.95em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .link {
    padding: 0;
    font: inherit;
    color: var(--vscode-textLink-foreground);
    background: none;
    border: none;
    cursor: pointer;
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .link:hover { text-decoration: underline; }
  .tag { flex: none; font-size: 0.85em; opacity: 0.7; }
  .tag.created { color: var(--vscode-gitDecoration-addedResourceForeground); opacity: 1; }
  .tag.deleted, .tag.failed { color: var(--vscode-errorForeground); opacity: 1; }
  .muted { opacity: 0.7; }
  .actions { display: flex; }
  .revert {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    font: inherit;
    color: var(--vscode-button-secondaryForeground);
    background: var(--vscode-button-secondaryBackground);
    border: none;
    border-radius: 2px;
    cursor: pointer;
  }
  .revert:hover { background: var(--vscode-button-secondaryHoverBackground); }
</style>
