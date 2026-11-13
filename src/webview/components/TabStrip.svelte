<script lang="ts">
  import type { ConversationView } from '../../chat/protocol.ts'
  import { post } from '../host.ts'
  import { view } from '../store.svelte.ts'
  import Icon from './Icon.svelte'

  function openPage(page: 'projects' | 'workflows') {
    view.openPage(page)
    post({ type: 'loadPage', page })
  }

  let { tabs, activeId }: { tabs: ConversationView[]; activeId: string | null } = $props()
</script>

<nav class="strip" aria-label="Conversations">
  <div class="tabs" role="tablist">
    {#each tabs as tab (tab.id)}
      <div class="tab" class:active={tab.id === activeId} role="presentation">
        <button
          type="button"
          class="tab-main"
          role="tab"
          aria-selected={tab.id === activeId}
          title={tab.title}
          onclick={() => tab.id !== activeId && post({ type: 'switchConversation', id: tab.id })}
        >
          {#if tab.busy}<span class="busy" aria-label="working"></span>{/if}
          <span class="label">{tab.title}</span>
          {#if tab.queued > 0}<span class="queued" title="{tab.queued} queued">{tab.queued}</span>{/if}
        </button>
        <button
          type="button"
          class="close"
          title="Close conversation"
          aria-label="Close {tab.title}"
          onclick={() => post({ type: 'deleteConversation', id: tab.id })}
        ><Icon name="x" size={12} /></button>
      </div>
    {/each}
  </div>
  <button type="button" class="icon-button" title="New chat" aria-label="New chat" onclick={() => post({ type: 'newConversation' })}>
    <Icon name="plus" />
  </button>
  <button type="button" class="icon-button" title="Workflows" aria-label="Workflows" onclick={() => openPage('workflows')}>
    <Icon name="bolt" />
  </button>
  <button type="button" class="icon-button" title="History" aria-label="History" onclick={() => post({ type: 'openHistory' })}>
    <Icon name="history" />
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
  .tabs {
    display: flex;
    flex: 1;
    min-width: 0;
    gap: 2px;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .tab {
    position: relative;
    display: flex;
    align-items: center;
    max-width: 160px;
    border-radius: 4px 4px 0 0;
    color: var(--vscode-tab-inactiveForeground, var(--vscode-foreground));
  }
  .tab:hover, .tab.active { background: var(--vscode-toolbar-hoverBackground); }
  .tab.active { color: var(--vscode-foreground); }
  .tab.active::after {
    content: '';
    position: absolute;
    left: 0; right: 0; bottom: 0;
    height: 2px;
    background: var(--ys-accent);
  }
  .tab-main {
    display: flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
    padding: 5px 2px 5px 8px;
    font: inherit;
    font-size: 0.85em;
    color: inherit;
    background: none;
    border: none;
    cursor: pointer;
  }
  .label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .busy {
    width: 6px; height: 6px; border-radius: 50%;
    background: var(--ys-accent);
    animation: pulse 1.2s ease-in-out infinite;
  }
  @keyframes pulse { 50% { opacity: 0.3; } }
  @media (prefers-reduced-motion: reduce) { .busy { animation: none; } }
  .queued {
    padding: 0 5px;
    border-radius: 8px;
    font-size: 0.8em;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
  }
  .close {
    display: flex;
    padding: 3px;
    margin-right: 3px;
    color: inherit;
    background: none;
    border: none;
    border-radius: 3px;
    cursor: pointer;
    opacity: 0;
  }
  .tab:hover .close, .tab.active .close, .close:focus-visible { opacity: 0.8; }
  .close:hover { background: var(--vscode-toolbar-hoverBackground); opacity: 1; }
</style>
