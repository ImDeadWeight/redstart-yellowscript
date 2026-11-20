<script lang="ts">
  // A run the window's reload or crash cut off. Continue sends "Continue the
  // task from where it stopped."; the run log of what had finished is on its
  // turn already, so the model picks up knowing it.
  import type { InterruptedView } from '../../chat/protocol.ts'
  import { post } from '../host.ts'
  import Icon from './Icon.svelte'

  let { interrupted }: { interrupted: InterruptedView } = $props()
  const count = $derived(interrupted.processes.length)
</script>

<section class="interrupted" aria-label="Task interrupted">
  <Icon name="alert" />
  <div class="text">
    <span>This task was interrupted when the window closed.</span>
    {#if count}
      <span class="processes">It had {count === 1 ? 'a process' : `${count} processes`} running: <code>{interrupted.processes.join(', ')}</code></span>
    {/if}
  </div>
  <button type="button" class="secondary" onclick={() => post({ type: 'dismissInterrupted' })}>Dismiss</button>
  {#if count}
    <button type="button" class="secondary" onclick={() => post({ type: 'resumeTask', restart: false })}>Continue</button>
    <button type="button" class="primary" onclick={() => post({ type: 'resumeTask', restart: true })}>Restart and continue</button>
  {:else}
    <button type="button" class="primary" onclick={() => post({ type: 'resumeTask', restart: false })}>Continue</button>
  {/if}
</section>

<style>
  .interrupted {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px 8px;
    padding: 8px 10px;
    border-radius: 6px;
    border: 1px solid var(--vscode-editorWarning-foreground);
    background: var(--ys-card);
  }
  .interrupted :global(.icon) { color: var(--vscode-editorWarning-foreground); }
  .text { flex: 1; min-width: 140px; display: flex; flex-direction: column; gap: 2px; }
  .processes { font-size: 0.88em; opacity: 0.8; }
  code { font-family: var(--vscode-editor-font-family); }
</style>
