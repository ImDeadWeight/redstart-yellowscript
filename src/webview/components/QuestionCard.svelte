<script lang="ts">
  // The assistant's ask_user question (agent-core ask-user.mjs), shown with
  // the composer — the same card chat-ui shows. One row per option: round
  // when one may be picked, square when any number may. A text field is always
  // there (an answer of the person's own, or a note on a pick), and typing in
  // the composer answers too. Skip tells the model the person did not answer.
  //
  // Two to four questions asked together are one card with a tab each (Nest's
  // D44). Each tab keeps its own picks and text; Send answers every question at
  // once, as `answers` (null for one left blank), and Next moves to the next
  // unanswered one.
  //
  // The rows are real radio/checkbox inputs, visually replaced, so the
  // keyboard and screen readers treat them as a choice list.
  import type { QuestionItemView, QuestionView } from '../../chat/protocol.ts'
  import { post } from '../host.ts'
  import { buildAnswer } from '../view-model.ts'
  import Icon from './Icon.svelte'

  let { question }: { question: QuestionView } = $props()

  const items: QuestionItemView[] = $derived(
    question.questions && question.questions.length > 1
      ? question.questions
      : [{ question: question.question, multiSelect: question.multiSelect, ...(question.options ? { options: question.options } : {}) }],
  )
  const several = $derived(items.length > 1)

  let tab = $state(0)
  let selected: string[][] = $state([[], [], [], []])
  let texts: string[] = $state(['', '', '', ''])
  const replies = $derived(items.map((_, i) => buildAnswer(selected[i] ?? [], texts[i] ?? '')))
  const answered = $derived(replies.filter((r) => r !== null).length)
  const current = $derived(items[tab] ?? items[0]!)
  const group = `ask-${Math.random().toString(36).slice(2)}`

  function choose(option: string, checked: boolean) {
    const now = selected[tab] ?? []
    selected[tab] = !current.multiSelect ? [option] : checked ? [...new Set([...now, option])] : now.filter((o) => o !== option)
  }

  function send() {
    if (!several) {
      if (replies[0]) post({ type: 'answer', id: question.id, answer: replies[0] })
      return
    }
    if (answered > 0) post({ type: 'answer', id: question.id, answer: { answers: replies } })
  }

  /** The next question with no answer yet, after this one; or null. */
  const nextOpen = $derived.by(() => {
    for (let step = 1; step < items.length; step++) {
      const i = (tab + step) % items.length
      if (!replies[i]) return i
    }
    return null
  })

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      if (several && nextOpen !== null && replies[tab]) tab = nextOpen
      else send()
    }
  }
</script>

<section class="card" aria-label="Question from Yellowscript">
  {#if several}
    <div class="tabs" role="tablist" aria-label="Questions">
      {#each items as item, i (i)}
        <button
          type="button"
          role="tab"
          class="tab"
          class:active={i === tab}
          aria-selected={i === tab}
          onclick={() => (tab = i)}
        >
          {#if replies[i]}<Icon name="check" size={11} />{/if}
          {item.header ?? `Question ${i + 1}`}
        </button>
      {/each}
    </div>
  {/if}

  <div class="question">
    <Icon name="question" size={16} />
    <span>{current.question}</span>
  </div>

  {#if current.options?.length}
    <p class="hint">{current.multiSelect ? 'Select all that apply' : 'Choose one'}</p>
    <div class="options" role={current.multiSelect ? 'group' : 'radiogroup'} aria-label={current.question}>
      {#each current.options as option (`${tab}:${option}`)}
        {@const on = (selected[tab] ?? []).includes(option)}
        <label class="option" class:on>
          <input
            class="sr-only"
            type={current.multiSelect ? 'checkbox' : 'radio'}
            name={`${group}-${tab}`}
            value={option}
            checked={on}
            onchange={(e) => choose(option, e.currentTarget.checked)}
          />
          <span class="mark" class:square={current.multiSelect} aria-hidden="true">
            {#if on}
              {#if current.multiSelect}<Icon name="check" size={11} />{:else}<span class="dot"></span>{/if}
            {/if}
          </span>
          <span class="text">{option}</span>
        </label>
      {/each}
    </div>
  {/if}

  <div class="row">
    <input
      class="free"
      placeholder={current.options?.length ? 'Something else, or a note…' : 'Type your answer…'}
      aria-label="Your answer"
      bind:value={texts[tab]}
      onkeydown={onKeydown}
    />
    <button type="button" class="secondary" onclick={() => post({ type: 'answer', id: question.id, answer: null })}>Skip</button>
    {#if several && nextOpen !== null}
      <button type="button" class="secondary" disabled={!replies[tab]} onclick={() => (tab = nextOpen ?? tab)}>Next</button>
    {/if}
    <button type="button" class="primary" disabled={several ? answered === 0 : !replies[0]} onclick={send}>
      {several ? `Send ${answered} of ${items.length}` : 'Send'}
    </button>
  </div>
</section>

<style>
  .card {
    padding: 10px;
    border-radius: 8px;
    border: 1px solid var(--ys-accent-border);
    background: var(--ys-card);
  }
  .tabs { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px; }
  .tab {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    font: inherit;
    font-size: 0.85em;
    color: inherit;
    background: transparent;
    border: 1px solid var(--ys-card-border);
    border-radius: 999px;
    cursor: pointer;
    opacity: 0.75;
  }
  .tab:hover { opacity: 1; }
  .tab.active { opacity: 1; border-color: var(--ys-accent); background: var(--ys-accent-faint); }
  .tab :global(.icon) { color: var(--ys-accent); }
  .question { display: flex; align-items: flex-start; gap: 8px; font-weight: 600; white-space: pre-wrap; }
  .question :global(.icon) { margin-top: 1px; color: var(--ys-accent); }
  .hint { margin: 2px 0 0 24px; font-size: 0.85em; opacity: 0.65; }
  .options { display: flex; flex-direction: column; gap: 4px; margin-top: 8px; }
  .option {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    border-radius: 6px;
    cursor: pointer;
    border: 1px solid var(--ys-card-border);
    background: var(--vscode-input-background);
  }
  .option:hover { background: var(--vscode-list-hoverBackground); }
  .option.on { border-color: var(--ys-accent); background: var(--ys-accent-faint); }
  .option:has(:focus-visible) { outline: 1px solid var(--vscode-focusBorder); }
  .mark {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    flex-shrink: 0;
    border-radius: 50%;
    border: 1px solid var(--vscode-descriptionForeground);
  }
  .mark.square { border-radius: 3px; }
  .on .mark { border-color: var(--ys-accent); color: var(--ys-accent); }
  .on .mark.square { background: var(--ys-accent); color: var(--vscode-button-foreground); }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ys-accent); }
  .text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .row { display: flex; gap: 6px; margin-top: 8px; }
  .free {
    flex: 1;
    min-width: 0;
    padding: 4px 8px;
    font: inherit;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 4px;
  }
  .free:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
</style>
