<script lang="ts">
  // The conversation's update_plan checklist (agent-core update-plan.mjs). The
  // model keeps it; this shows it, and offers the one thing the person needs:
  // clearing it. While steps are open every request carries them and the first
  // answer of each flow gets a "still open" nudge, so a plan the person has
  // moved on from would keep steering the chat.
  //
  // Open while steps are open; one line once they are all done or skipped.
  import type { PlanStepView } from '../../chat/protocol.ts'
  import { post } from '../host.ts'
  import { planProgress } from '../view-model.ts'
  import Icon from './Icon.svelte'

  let { steps }: { steps: PlanStepView[] } = $props()

  const progress = $derived(planProgress(steps))
  let override: boolean | null = $state(null)
  const expanded = $derived(override ?? progress.open > 0)

  // A changed plan goes back to the default view.
  let last = ''
  $effect(() => {
    const key = JSON.stringify(steps)
    if (key !== last) {
      last = key
      override = null
    }
  })

  const icons = { done: 'circle-check', in_progress: 'circle-dot', skipped: 'circle-minus', pending: 'circle' } as const
</script>

<section class="plan" aria-label="Plan">
  <div class="head">
    <Icon name="list" />
    <button type="button" class="toggle" aria-expanded={expanded} onclick={() => (override = !expanded)}>
      <span>Plan · {progress.label}</span>
      <Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={12} />
    </button>
    <button type="button" class="clear" title="Clear the plan" aria-label="Clear the plan" onclick={() => post({ type: 'clearPlan' })}>
      <Icon name="x" size={12} />
    </button>
  </div>
  {#if expanded}
    <ol>
      {#each steps as step, i (i)}
        <li class={step.status}>
          <Icon name={icons[step.status]} size={13} label={step.status.replace('_', ' ')} />
          <span>
            {step.text}
            {#if step.note}<span class="note"> · {step.note}</span>{/if}
          </span>
        </li>
      {/each}
    </ol>
  {/if}
</section>

<style>
  .plan {
    padding: 5px 8px;
    border-radius: 6px;
    font-size: 0.9em;
    border: 1px solid var(--ys-card-border);
    background: var(--ys-card);
  }
  .head { display: flex; align-items: center; gap: 6px; }
  .head > :global(.icon) { opacity: 0.7; }
  .toggle {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 0;
    font: inherit;
    font-weight: 600;
    color: inherit;
    text-align: left;
    background: none;
    border: none;
    cursor: pointer;
  }
  .clear {
    display: flex;
    padding: 2px;
    color: inherit;
    background: none;
    border: none;
    border-radius: 3px;
    cursor: pointer;
    opacity: 0.6;
  }
  .clear:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
  ol { list-style: none; margin: 6px 0 2px; padding: 0; display: flex; flex-direction: column; gap: 3px; }
  li { display: flex; align-items: flex-start; gap: 6px; }
  li :global(.icon) { margin-top: 2px; }
  li.done :global(.icon) { color: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); }
  li.in_progress :global(.icon) { color: var(--ys-accent); }
  li.done span, li.skipped span { opacity: 0.6; }
  li.skipped span { text-decoration: line-through; }
  .note { opacity: 0.7; }
</style>
