<script lang="ts">
  import { view } from '../store.svelte.ts'
  import LoginScreen from './LoginScreen.svelte'
  import TabStrip from './TabStrip.svelte'
  import HistoryPanel from './HistoryPanel.svelte'
  import Transcript from './Transcript.svelte'
  import PlanBar from './PlanBar.svelte'
  import QuestionCard from './QuestionCard.svelte'
  import LimitPrompt from './LimitPrompt.svelte'
  import Composer from './Composer.svelte'

  const s = $derived(view.current)
  const connected = $derived(s.session.connection === 'connected')
</script>

{#if s.stale}
  <div class="stale" role="alert">
    Yellowscript was updated, but this panel is still the old version. Run
    <strong>Developer: Reload Window</strong> to load the new one.
  </div>
{:else if !connected}
  <LoginScreen session={s.session} />
{:else}
  <div class="shell">
    <TabStrip tabs={s.tabs} activeId={s.conversationId} />
    {#if s.history.open}
      <HistoryPanel items={s.history.items} />
    {/if}
    <Transcript messages={s.messages} notices={s.notices} generation={s.generation} />
    <div class="dock">
      {#if s.conversation.plan && s.conversation.plan.length > 0}
        <PlanBar steps={s.conversation.plan} />
      {/if}
      {#if s.conversation.question}
        {#key s.conversation.question.id}
          <QuestionCard question={s.conversation.question} />
        {/key}
      {:else if s.conversation.atTurnLimit}
        <LimitPrompt />
      {/if}
      <Composer session={s.session} viewState={s} />
    </div>
  </div>
{/if}

<style>
  .shell {
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100vh;
    min-height: 0;
  }
  .dock {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 6px 8px 8px;
    /* The plan and a question can be tall; the transcript keeps the room. */
    max-height: 70vh;
    overflow-y: auto;
    border-top: 1px solid var(--vscode-panel-border, transparent);
    background: var(--ys-surface);
  }
  .stale {
    margin: 12px;
    padding: 10px 12px;
    border-radius: 6px;
    border: 1px solid var(--vscode-inputValidation-warningBorder, var(--ys-accent));
    background: var(--vscode-inputValidation-warningBackground, transparent);
  }
</style>
