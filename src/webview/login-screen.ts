// =============================================================================
// Login screen renderer for the Yellowscript webview.
// =============================================================================
// Replaces the transcript + composer when the session is not `connected`.
// State-dependent content:
//   - disconnected / error       → Connect button
//   - discovering / connecting   → spinner
//   - unauthenticated            → sign-in form (password / apiKey tabs)
//
// Credentials are dispatched to the host via the `signIn` protocol message;
// the host calls `manager.signInWithPassword/ApiKey` directly. No credentials
// are stored or rendered here beyond what the user typed.
// =============================================================================

import type { SessionSnapshot, WebviewMessage } from '../chat/protocol.ts'

// Inline the full pixel-art crest so the webview never needs a local resource
// request for it (the webview security model only allows what the host loads).
const CREST_HTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="64" height="64" shape-rendering="crispEdges">
  <rect x="15" y="1" width="2" height="1" fill="#1c1917"/>
  <rect x="15" y="2" width="2" height="1" fill="#1c1917"/>
  <rect x="13" y="3" width="6" height="1" fill="#1c1917"/>
  <rect x="12" y="4" width="8" height="1" fill="#1c1917"/>
  <rect x="11" y="5" width="10" height="1" fill="#1c1917"/>
  <rect x="10" y="6" width="12" height="1" fill="#1c1917"/>
  <rect x="10" y="7" width="12" height="1" fill="#1c1917"/>
  <rect x="10" y="8" width="2" height="1" fill="#1c1917"/>
  <rect x="12" y="8" width="2" height="1" fill="#fafaf9"/>
  <rect x="14" y="8" width="4" height="1" fill="#1c1917"/>
  <rect x="18" y="8" width="2" height="1" fill="#fafaf9"/>
  <rect x="20" y="8" width="2" height="1" fill="#1c1917"/>
  <rect x="10" y="9" width="2" height="1" fill="#1c1917"/>
  <rect x="12" y="9" width="2" height="1" fill="#fafaf9"/>
  <rect x="14" y="9" width="4" height="1" fill="#1c1917"/>
  <rect x="18" y="9" width="2" height="1" fill="#fafaf9"/>
  <rect x="20" y="9" width="2" height="1" fill="#1c1917"/>
  <rect x="10" y="10" width="12" height="1" fill="#1c1917"/>
  <rect x="10" y="11" width="12" height="1" fill="#1c1917"/>
  <rect x="5" y="12" width="3" height="1" fill="#f97316"/>
  <rect x="11" y="12" width="10" height="1" fill="#1c1917"/>
  <rect x="24" y="12" width="3" height="1" fill="#f97316"/>
  <rect x="4" y="13" width="5" height="1" fill="#f97316"/>
  <rect x="12" y="13" width="3" height="1" fill="#1c1917"/>
  <rect x="15" y="13" width="2" height="1" fill="#d97706"/>
  <rect x="17" y="13" width="3" height="1" fill="#1c1917"/>
  <rect x="23" y="13" width="5" height="1" fill="#f97316"/>
  <rect x="4" y="14" width="6" height="1" fill="#f97316"/>
  <rect x="11" y="14" width="4" height="1" fill="#1c1917"/>
  <rect x="15" y="14" width="2" height="1" fill="#d97706"/>
  <rect x="17" y="14" width="4" height="1" fill="#1c1917"/>
  <rect x="22" y="14" width="6" height="1" fill="#f97316"/>
  <rect x="4" y="15" width="6" height="1" fill="#f97316"/>
  <rect x="12" y="15" width="8" height="1" fill="#1c1917"/>
  <rect x="22" y="15" width="6" height="1" fill="#f97316"/>
  <rect x="4" y="16" width="6" height="1" fill="#f97316"/>
  <rect x="11" y="16" width="10" height="1" fill="#1c1917"/>
  <rect x="22" y="16" width="6" height="1" fill="#f97316"/>
  <rect x="4" y="17" width="6" height="1" fill="#f97316"/>
  <rect x="10" y="17" width="3" height="1" fill="#1c1917"/>
  <rect x="13" y="17" width="1" height="1" fill="#fafaf9"/>
  <rect x="14" y="17" width="4" height="1" fill="#1c1917"/>
  <rect x="18" y="17" width="1" height="1" fill="#fafaf9"/>
  <rect x="19" y="17" width="3" height="1" fill="#1c1917"/>
  <rect x="22" y="17" width="6" height="1" fill="#f97316"/>
  <rect x="4" y="18" width="7" height="1" fill="#f97316"/>
  <rect x="11" y="18" width="1" height="1" fill="#1c1917"/>
  <rect x="12" y="18" width="8" height="1" fill="#fafaf9"/>
  <rect x="20" y="18" width="1" height="1" fill="#1c1917"/>
  <rect x="21" y="18" width="7" height="1" fill="#f97316"/>
  <rect x="4" y="19" width="1" height="1" fill="#f97316"/>
  <rect x="5" y="19" width="2" height="1" fill="#c2410c"/>
  <rect x="7" y="19" width="4" height="1" fill="#f97316"/>
  <rect x="11" y="19" width="10" height="1" fill="#fafaf9"/>
  <rect x="21" y="19" width="4" height="1" fill="#f97316"/>
  <rect x="25" y="19" width="2" height="1" fill="#c2410c"/>
  <rect x="27" y="19" width="1" height="1" fill="#f97316"/>
  <rect x="4" y="20" width="4" height="1" fill="#c2410c"/>
  <rect x="8" y="20" width="3" height="1" fill="#f97316"/>
  <rect x="11" y="20" width="10" height="1" fill="#fafaf9"/>
  <rect x="21" y="20" width="3" height="1" fill="#f97316"/>
  <rect x="24" y="20" width="4" height="1" fill="#c2410c"/>
  <rect x="4" y="21" width="5" height="1" fill="#c2410c"/>
  <rect x="9" y="21" width="1" height="1" fill="#f97316"/>
  <rect x="10" y="21" width="1" height="1" fill="#1c1917"/>
  <rect x="11" y="21" width="10" height="1" fill="#fafaf9"/>
  <rect x="21" y="21" width="1" height="1" fill="#1c1917"/>
  <rect x="22" y="21" width="1" height="1" fill="#f97316"/>
  <rect x="23" y="21" width="5" height="1" fill="#c2410c"/>
  <rect x="4" y="22" width="5" height="1" fill="#c2410c"/>
  <rect x="9" y="22" width="1" height="1" fill="#f97316"/>
  <rect x="10" y="22" width="1" height="1" fill="#1c1917"/>
  <rect x="11" y="22" width="10" height="1" fill="#fafaf9"/>
  <rect x="21" y="22" width="1" height="1" fill="#1c1917"/>
  <rect x="22" y="22" width="1" height="1" fill="#f97316"/>
  <rect x="23" y="22" width="5" height="1" fill="#c2410c"/>
  <rect x="4" y="23" width="5" height="1" fill="#c2410c"/>
  <rect x="9" y="23" width="1" height="1" fill="#f97316"/>
  <rect x="10" y="23" width="1" height="1" fill="#1c1917"/>
  <rect x="11" y="23" width="10" height="1" fill="#fafaf9"/>
  <rect x="21" y="23" width="1" height="1" fill="#1c1917"/>
  <rect x="22" y="23" width="1" height="1" fill="#f97316"/>
  <rect x="23" y="23" width="5" height="1" fill="#c2410c"/>
  <rect x="4" y="24" width="4" height="1" fill="#c2410c"/>
  <rect x="8" y="24" width="3" height="1" fill="#1c1917"/>
  <rect x="11" y="24" width="10" height="1" fill="#fafaf9"/>
  <rect x="21" y="24" width="3" height="1" fill="#1c1917"/>
  <rect x="24" y="24" width="4" height="1" fill="#c2410c"/>
  <rect x="6" y="25" width="1" height="1" fill="#c2410c"/>
  <rect x="7" y="25" width="5" height="1" fill="#1c1917"/>
  <rect x="12" y="25" width="8" height="1" fill="#fafaf9"/>
  <rect x="20" y="25" width="5" height="1" fill="#1c1917"/>
  <rect x="25" y="25" width="1" height="1" fill="#c2410c"/>
  <rect x="8" y="26" width="5" height="1" fill="#1c1917"/>
  <rect x="13" y="26" width="6" height="1" fill="#fafaf9"/>
  <rect x="19" y="26" width="5" height="1" fill="#1c1917"/>
  <rect x="8" y="27" width="16" height="1" fill="#1c1917"/>
  <rect x="10" y="28" width="12" height="1" fill="#1c1917"/>
  <rect x="11" y="29" width="10" height="1" fill="#1c1917"/>
</svg>`

export function renderLoginScreen(post: (message: WebviewMessage) => void, session: SessionSnapshot): HTMLElement {
  const root = document.createElement('div')
  root.className = 'login-screen'

  const crest = document.createElement('div')
  crest.className = 'login-crest'
  crest.innerHTML = CREST_HTML
  root.appendChild(crest)

  const title = document.createElement('h1')
  title.className = 'login-title'
  title.textContent = 'Yellowscript'
  root.appendChild(title)

  const detail = document.createElement('p')
  detail.className = 'login-detail'
  detail.textContent = session.detail
  root.appendChild(detail)

  if (session.connection === 'unauthenticated') {
    root.appendChild(buildSignInForm(post))
  } else if (session.connection === 'discovering' || session.connection === 'connecting') {
    const spinner = document.createElement('div')
    spinner.className = 'login-spinner'
    root.appendChild(spinner)

    const retryText = document.createElement('p')
    retryText.className = 'login-retry-hint'
    retryText.textContent = 'Retrying every 10 seconds. Start Redstart Nest and this will connect on its own.'
    root.appendChild(retryText)
  } else {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'login-button'
    button.textContent = session.connection === 'error' ? 'Retry' : 'Connect'
    button.addEventListener('click', () => post({ type: 'runCommand', command: 'connect' }))
    root.appendChild(button)
  }

  return root
}

function buildSignInForm(post: (message: WebviewMessage) => void): HTMLElement {
  const form = document.createElement('form')
  form.className = 'login-form'

  const tabs = document.createElement('div')
  tabs.className = 'login-tabs'

  const passwordTab = document.createElement('button')
  passwordTab.type = 'button'
  passwordTab.className = 'login-tab active'
  passwordTab.textContent = 'Password'
  passwordTab.addEventListener('click', () => switchTab('password'))

  const apiKeyTab = document.createElement('button')
  apiKeyTab.type = 'button'
  apiKeyTab.className = 'login-tab'
  apiKeyTab.textContent = 'API key'
  apiKeyTab.addEventListener('click', () => switchTab('apiKey'))

  tabs.appendChild(passwordTab)
  tabs.appendChild(apiKeyTab)
  form.appendChild(tabs)

  const fields = document.createElement('div')
  fields.className = 'login-fields'

  const passwordFields = document.createElement('div')
  passwordFields.className = 'login-field-group active'
  passwordFields.dataset.tab = 'password'

  const usernameInput = document.createElement('input')
  usernameInput.type = 'text'
  usernameInput.placeholder = 'Username'
  usernameInput.autocomplete = 'username'
  usernameInput.className = 'login-input'
  passwordFields.appendChild(usernameInput)

  const passwordInput = document.createElement('input')
  passwordInput.type = 'password'
  passwordInput.placeholder = 'Password'
  passwordInput.autocomplete = 'current-password'
  passwordInput.className = 'login-input'
  passwordFields.appendChild(passwordInput)

  const apiKeyFields = document.createElement('div')
  apiKeyFields.className = 'login-field-group'
  apiKeyFields.dataset.tab = 'apiKey'

  const keyInput = document.createElement('input')
  keyInput.type = 'password'
  keyInput.placeholder = 'Paste an rst_ API key'
  keyInput.className = 'login-input'
  apiKeyFields.appendChild(keyInput)

  fields.appendChild(passwordFields)
  fields.appendChild(apiKeyFields)
  form.appendChild(fields)

  const submit = document.createElement('button')
  submit.type = 'submit'
  submit.className = 'login-button'
  submit.textContent = 'Sign in'
  form.appendChild(submit)

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const active = fields.querySelector('.login-field-group.active') as HTMLElement | null
    const method = active?.dataset.tab ?? 'password'
    if (method === 'password') {
      const username = usernameInput.value.trim()
      const password = passwordInput.value
      if (!username || !password) return
      post({ type: 'signIn', method: 'password', username, password })
    } else {
      const key = keyInput.value.trim()
      if (!key) return
      post({ type: 'signIn', method: 'apiKey', key })
    }
  })

  function switchTab(method: 'password' | 'apiKey'): void {
    tabs.querySelectorAll('.login-tab').forEach((tab) => {
      tab.classList.toggle('active', (tab as HTMLElement).textContent?.toLowerCase().includes(method === 'password' ? 'password' : 'api'))
    })
    fields.querySelectorAll('.login-field-group').forEach((group) => {
      (group as HTMLElement).classList.toggle('active', (group as HTMLElement).dataset.tab === method)
    })
  }

  return form
}
