<script lang="ts">
  // The assistant's ask_user question (agent-core ask-user.mjs), shown with
  // the composer — the same card chat-ui shows. One row per option: round
  // when one may be picked, square when any number may. A text field is always
  // there (an answer of the person's own, or a note on a pick), and typing in
  // the composer answers too. Skip tells the model the person did not answer.
  //
  // The rows are real radio/checkbox inputs, visually replaced, so the
  // keyboard and screen readers treat them as a choice list.
  import type { QuestionView } from '../../chat/protocol.ts'
  import { post } from '../host.ts'
  import { buildAnswer } from '../view-model.ts'
  import Icon from './Icon.svelte'

  let { question }: { question: QuestionView } = $props()

  let selected: string[] = $state([])
  let text = $state('')
  const answer = $derived(buildAnswer(selected, text))
  const group = `ask-${Math.random().toString(36).slice(2)}`

  function choose(option: string, checked: boolean) {
    if (!question.multiSelect) {
      selected = [option]
      return
    }
    selected = checked ? [...new Set([...selected, option])] : selected.filter((o) => o !== option)
  }

  function send() {
    if (answer) post({ type: 'answer', id: question.id, answer })
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      send()
    }
  }
</script>

<section class="card" aria-label="Question from Yellowscript">
  <div class="question">
    <Icon name="question" size={16} />
    <span>{question.question}</span>
  </div>

  {#if question.options?.length}
    <p class="hint">{question.multiSelect ? 'Select all that apply' : 'Choose one'}</p>
    <div class="options" role={question.multiSelect ? 'group' : 'radiogroup'} aria-label={question.question}>
      {#each question.options as option (option)}
        {@const on = selected.includes(option)}
        <label class="option" class:on>
          <input
            class="sr-only"
            type={question.multiSelect ? 'checkbox' : 'radio'}
            name={group}
            value={option}
            checked={on}
            onchange={(e) => choose(option, e.currentTarget.checked)}
          />
          <span class="mark" class:square={question.multiSelect} aria-hidden="true">
            {#if on}
              {#if question.multiSelect}<Icon name="check" size={11} />{:else}<span class="dot"></span>{/if}
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
      placeholder={question.options?.length ? 'Something else, or a note…' : 'Type your answer…'}
      aria-label="Your answer"
      bind:value={text}
      onkeydown={onKeydown}
    />
    <button type="button" class="secondary" onclick={() => post({ type: 'answer', id: question.id, answer: null })}>Skip</button>
    <button type="button" class="primary" disabled={!answer} onclick={send}>Send</button>
  </div>
</section>

<style>
  .card {
    padding: 10px;
    border-radius: 8px;
    border: 1px solid var(--ys-accent-border);
    background: var(--ys-card);
  }
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
