<script lang="ts">
  import type { ContextUsageView } from '../../chat/protocol.ts'
  import { contextMeter } from '../view-model.ts'

  /** How full the model's window was on the last request: a ring and a
   *  number, with the token counts (and any trimming) on hover. */
  let { usage }: { usage: ContextUsageView | null | undefined } = $props()
  const meter = $derived(contextMeter(usage))
  const R = 5.5
  const C = 2 * Math.PI * R
</script>

{#if meter}
  <span class="meter {meter.level}" class:trimmed={!!usage?.trimmed} title={meter.title} role="img" aria-label={meter.title}>
    {#if meter.fraction !== null}
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
        <circle class="track" cx="7" cy="7" r={R} />
        <circle class="fill" cx="7" cy="7" r={R} stroke-dasharray="{C * meter.fraction} {C}" transform="rotate(-90 7 7)" />
      </svg>
    {/if}
    <span>{meter.label}</span>
  </span>
{/if}

<style>
  .meter { display: flex; align-items: center; gap: 3px; font-size: 0.8em; opacity: 0.6; white-space: nowrap; cursor: default; }
  .meter:hover { opacity: 0.95; }
  circle { fill: none; stroke-width: 2; }
  .track { stroke: var(--ys-card-border); }
  .fill { stroke: currentColor; stroke-linecap: round; }
  .high { color: var(--vscode-editorWarning-foreground); opacity: 0.85; }
  .full { color: var(--vscode-errorForeground); opacity: 0.95; }
  .trimmed span::after { content: ' ✂'; }
</style>
