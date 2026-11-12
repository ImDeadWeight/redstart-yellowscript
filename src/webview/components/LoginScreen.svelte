<script lang="ts">
  // Shown instead of the chat whenever the session is not connected:
  //   disconnected / error       → Connect (or Retry)
  //   discovering / connecting   → progress, with the auto-retry hint
  //   unauthenticated            → sign-in: password, API key, or a key the
  //                                 Nest issues to this app
  // Credentials go to the host in one `signIn` message; nothing is stored or
  // shown here beyond what the person typed.
  import type { SessionSnapshot } from '../../chat/protocol.ts'
  import { CREST_HTML } from '../crest.ts'
  import { post } from '../host.ts'
  import Icon from './Icon.svelte'

  let { session }: { session: SessionSnapshot } = $props()

  let method: 'password' | 'apiKey' = $state('password')
  let username = $state('')
  let password = $state('')
  let key = $state('')
  let submitting = $state(false)

  const ready = $derived(method === 'password' ? !!username.trim() && !!password : !!key.trim())

  // A new state from the host (rejected, connected, error) ends the attempt.
  $effect(() => {
    void session.connection
    void session.detail
    submitting = false
  })

  function submit(event: SubmitEvent) {
    event.preventDefault()
    if (!ready || submitting) return
    submitting = true
    if (method === 'password') post({ type: 'signIn', method: 'password', username: username.trim(), password })
    else post({ type: 'signIn', method: 'apiKey', key: key.trim() })
    password = ''
  }

  const working = $derived(session.connection === 'discovering' || session.connection === 'connecting')
</script>

<main class="login">
  <div class="crest">{@html CREST_HTML}</div>
  <h1>Yellowscript</h1>
  <p class="detail">{session.detail}</p>

  {#if session.connection === 'unauthenticated'}
    <form onsubmit={submit}>
      <div class="tabs" role="tablist" aria-label="Sign-in method">
        <button type="button" role="tab" aria-selected={method === 'password'} class:active={method === 'password'} onclick={() => (method = 'password')}>Password</button>
        <button type="button" role="tab" aria-selected={method === 'apiKey'} class:active={method === 'apiKey'} onclick={() => (method = 'apiKey')}>API key</button>
      </div>
      {#if method === 'password'}
        <input type="text" placeholder="Username" autocomplete="username" bind:value={username} aria-label="Username" />
        <input type="password" placeholder="Password" autocomplete="current-password" bind:value={password} aria-label="Password" />
      {:else}
        <input type="password" placeholder="Paste an rst_ API key" bind:value={key} aria-label="API key" />
      {/if}
      <button type="submit" class="primary wide" disabled={!ready || submitting}>
        {#if submitting}<Icon name="spinner" size={12} />{/if}Sign in
      </button>
      <button type="button" class="link" onclick={() => post({ type: 'signIn', method: 'clientKey' })}>
        Or ask the Nest for a key for this app
      </button>
    </form>
  {:else if working}
    <div class="progress"><Icon name="spinner" size={18} label="Connecting" /></div>
    <p class="hint">Retrying every 10 seconds. Start Redstart Nest and this connects on its own.</p>
  {:else}
    <button type="button" class="primary wide" onclick={() => post({ type: 'runCommand', command: 'connect' })}>
      <Icon name={session.connection === 'error' ? 'refresh' : 'server'} size={12} />
      {session.connection === 'error' ? 'Retry' : 'Connect to Nest'}
    </button>
    <button type="button" class="link" onclick={() => post({ type: 'runCommand', command: 'showStatus' })}>Connection details</button>
  {/if}
</main>

<style>
  .login {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 24px 20px;
    text-align: center;
  }
  .crest :global(svg) { width: 56px; height: 56px; image-rendering: pixelated; }
  h1 { margin: 4px 0 0; font-size: 1.3em; font-weight: 600; }
  .detail { margin: 0 0 8px; max-width: 280px; opacity: 0.75; }
  form { display: flex; flex-direction: column; gap: 8px; width: 100%; max-width: 280px; }
  .tabs {
    display: flex;
    padding: 2px;
    border-radius: 6px;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
  }
  .tabs button {
    flex: 1;
    padding: 4px;
    font: inherit;
    color: inherit;
    background: none;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    opacity: 0.7;
  }
  .tabs button.active { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
  input {
    padding: 6px 8px;
    font: inherit;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 4px;
  }
  input:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .wide { justify-content: center; width: 100%; max-width: 280px; padding: 6px 12px; }
  .progress { padding: 8px; color: var(--ys-accent); }
  .hint { margin: 0; max-width: 260px; font-size: 0.85em; opacity: 0.6; }
</style>
