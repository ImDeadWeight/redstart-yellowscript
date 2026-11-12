<script lang="ts">
  import { post } from '../host.ts'
  import Icon from './Icon.svelte'
</script>

<section class="limit" aria-label="Turn limit reached">
  <Icon name="alert" />
  <span class="text">Yellowscript has used its turns for this request and is still working.</span>
  <button type="button" class="secondary" onclick={() => post({ type: 'continueAtLimit', go: false })}>Stop</button>
  <button type="button" class="primary" onclick={() => post({ type: 'continueAtLimit', go: true })}>Keep going</button>
</section>

<style>
  .limit {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px 8px;
    padding: 8px 10px;
    border-radius: 6px;
    border: 1px solid var(--vscode-editorWarning-foreground);
    background: var(--ys-card);
  }
  .limit :global(.icon) { color: var(--vscode-editorWarning-foreground); }
  .text { flex: 1; min-width: 140px; }
</style>
