<script lang="ts">
  import { tabLabel, type ConversationView, type PageName, type SurfaceKind } from '../../chat/protocol.ts'
  import { post } from '../host.ts'
  import { flushDraft } from '../drafts.ts'
  import { view } from '../store.svelte.ts'
  import Icon from './Icon.svelte'

  function openPage(page: PageName) {
    view.openPage(page)
    post({ type: 'loadPage', page })
  }

  let { tabs, activeId, surface }: { tabs: ConversationView[]; activeId: string | null; surface: SurfaceKind } = $props()

  let strip: HTMLDivElement | undefined = $state()
  // The active tab is always in view: with many chats the strip scrolls, and
  // a chat scrolled out of sight is a chat that seems to have vanished.
  $effect(() => {
    void tabs
    const active = activeId
    if (!strip || !active) return
    const el = strip.querySelector<HTMLElement>(`[data-tab="${CSS.escape(active)}"]`)
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  })
</script>

<nav class="strip" aria-label="Conversations">
  <!-- An editor tab is one chat; VSCode's own tab is its tab. -->
  <div class="tabs" role="tablist" bind:this={strip} hidden={surface === 'editor'}>
    {#each tabs as tab (tab.id)}
      <div class="tab" class:active={tab.id === activeId} role="presentation" data-tab={tab.id}>
        <button
          type="button"
          class="tab-main"
          role="tab"
          aria-selected={tab.id === activeId}
          title="{tab.title} (double-click to open in an editor tab)"
          ondblclick={() => {
            flushDraft()
            post({ type: 'moveToEditor', id: tab.id })
          }}
          onclick={() => {
            if (tab.id === activeId) return
            flushDraft()
            post({ type: 'switchConversation', id: tab.id })
          }}
        >
          {#if tab.busy}<span class="busy" aria-label="working"></span>{/if}
          <span class="label">{tabLabel(tab.title)}</span>
          {#if tab.queued > 0}<span class="queued" title="{tab.queued} queued">{tab.queued}</span>{/if}
        </button>
        <button
          type="button"
          class="close"
          title="Close conversation"
          aria-label="Close {tab.title}"
          onclick={() => {
            // The host decides between history and deletion by whether
            // anything was typed, so the draft must reach it first.
            flushDraft()
            post({ type: 'deleteConversation', id: tab.id })
          }}
        ><Icon name="x" size={12} /></button>
      </div>
    {/each}
  </div>
  {#if surface === 'editor'}
    <!-- An editor tab is one chat: its title heads the bar, in full. -->
    <h1 class="title" title={tabs[0]?.title ?? ''}>
      {#if tabs[0]?.busy}<span class="busy" aria-label="working"></span>{/if}
      <span class="label">{tabs[0]?.title ?? 'New chat'}</span>
    </h1>
    <button type="button" class="icon-button" title="Move to sidebar" aria-label="Move to sidebar" onclick={() => {
      flushDraft()
      post({ type: 'moveToSidebar' })
    }}>
      <Icon name="sidebar" />
    </button>
  {/if}
  <button type="button" class="icon-button" title={surface === 'editor' ? 'New chat in a new tab' : 'New chat'} aria-label="New chat" onclick={() => post({ type: 'newConversation' })}>
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
  .tabs {
    display: flex;
    flex: 1;
    min-width: 0;
    gap: 2px;
    overflow-x: auto;
    scrollbar-width: thin;
  }
  .tabs[hidden] { display: none; }
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
