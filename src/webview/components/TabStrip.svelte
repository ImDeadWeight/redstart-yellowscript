<script lang="ts">
  // The bar above a chat: its title, and the actions. A chat is an editor tab,
  // so VSCode's own tab row is the list of open chats; History has the rest.
  import type { ConversationView, PageName } from '../../chat/protocol.ts'
  import { post } from '../host.ts'
  import { view } from '../store.svelte.ts'
  import Icon from './Icon.svelte'

  function openPage(page: PageName) {
    view.openPage(page)
    post({ type: 'loadPage', page })
  }

  let { tabs }: { tabs: ConversationView[] } = $props()
  const own = $derived(tabs[0])
</script>

<nav class="strip" aria-label="Chat">
  <h1 class="title" title={own?.title ?? ''}>
    {#if own?.busy}<span class="busy" aria-label="working"></span>{/if}
    <span class="label">{own?.title ?? 'New chat'}</span>
  </h1>
  <button type="button" class="icon-button" title="New chat in a new tab" aria-label="New chat" onclick={() => post({ type: 'newConversation' })}>
    <Icon name="plus" />
  </button>
  <button type="button" class="icon-button" title="Workflows" aria-label="Workflows" onclick={() => openPage('workflows')}>
    <Icon name="bolt" />
  </button>
  <button type="button" class="icon-button" title="History" aria-label="History" onclick={() => post({ type: 'openHistory' })}>
    <Icon name="history" />
  </button>
  <button type="button" class="icon-button" title="Settings" aria-label="Settings" onclick={() => openPage('settings')}>
    <Icon name="settings" />
  </button>
</nav>

<style>
  .strip {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 4px 4px 0 4px;
    border-bottom: 1px solid var(--vscode-panel-border, transparent);
    min-height: 32px;
  }
  .title {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    min-width: 0;
    margin: 0;
    padding: 4px 6px 6px;
    font-size: 0.95em;
    font-weight: 600;
    text-align: left;
  }
  .label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .busy {
    width: 6px; height: 6px; border-radius: 50%;
    background: var(--ys-accent);
    animation: pulse 1.2s ease-in-out infinite;
  }
  @keyframes pulse { 50% { opacity: 0.3; } }
  @media (prefers-reduced-motion: reduce) { .busy { animation: none; } }
</style>
