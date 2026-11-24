<script lang="ts">
  // Yellowscript's own settings, in the panel's look rather than VS Code's
  // Settings editor. Each change goes to the host, which writes it and sends
  // every value back; what is on screen is always what is saved.
  import { SETTING_GROUPS, type SettingValue, type SettingView } from '../../chat/settings.ts'
  import { post } from '../host.ts'
  import Page from './Page.svelte'
  import Icon from './Icon.svelte'

  let { settings }: { settings: SettingView[] | null } = $props()

  /** New list entries being typed, by setting key. */
  let adding: Record<string, string> = $state({})

  const groups = $derived(
    SETTING_GROUPS.map((group) => ({ group, items: (settings ?? []).filter((s) => s.group === group) })).filter((g) => g.items.length > 0),
  )

  function save(key: string, value: SettingValue) {
    post({ type: 'updateSetting', key, value })
  }

  function isDefault(s: SettingView): boolean {
    return JSON.stringify(s.value) === JSON.stringify(s.defaultValue)
  }

  function commitNumber(s: SettingView, input: HTMLInputElement) {
    const n = input.valueAsNumber
    if (!Number.isFinite(n)) {
      input.value = String(s.value)
      return
    }
    save(s.key, n)
  }

  function addItem(s: SettingView, event: SubmitEvent) {
    event.preventDefault()
    const item = (adding[s.key] ?? '').trim()
    if (!item) return
    const list = s.value as string[]
    if (!list.includes(item)) save(s.key, [...list, item])
    adding[s.key] = ''
  }

  function toggleOption(s: SettingView, option: string) {
    const list = s.value as string[]
    save(s.key, list.includes(option) ? list.filter((v) => v !== option) : [...list, option])
  }

  /** A description split on backticks: odd pieces are code. */
  const pieces = (text: string) => text.split('`')
</script>

<Page title="Settings" subtitle="Yellowscript's settings for you and this workspace.">
  {#if settings === null}
    <p class="muted"><Icon name="spinner" /> Loading…</p>
  {:else}
    {#each groups as { group, items } (group)}
      <section class="group" aria-labelledby="group-{group}">
        <h3 id="group-{group}">{group}</h3>
        {#each items as s (s.key)}
          {@const id = `setting-${s.key.replace(/\./g, '-')}`}
          <div class="setting" class:changed={!isDefault(s)}>
            <div class="head">
              <label class="label" id="{id}-label" for={id}>{s.label}</label>
              {#if s.workspace}<span class="scope" title="Set in this workspace's settings">Workspace</span>{/if}
              {#if !isDefault(s)}
                <button type="button" class="link reset" title="Back to the default" onclick={() => save(s.key, s.defaultValue)}>Reset</button>
              {/if}
              {#if s.kind === 'boolean'}
                <button
                  {id}
                  type="button"
                  class="switch"
                  class:on={s.value === true}
                  role="switch"
                  aria-checked={s.value === true}
                  aria-labelledby="{id}-label"
                  aria-describedby="{id}-desc"
                  onclick={() => save(s.key, s.value !== true)}
                ><span class="knob"></span></button>
              {/if}
            </div>
            <p class="desc" id="{id}-desc">
              {#each pieces(s.description) as piece, i (i)}{#if i % 2 === 1}<code>{piece}</code>{:else}{piece}{/if}{/each}
            </p>

            {#if s.kind === 'number'}
              <input
                {id}
                class="field number"
                type="number"
                min={s.min}
                max={s.max}
                step={s.integer ? 1 : 'any'}
                value={s.value}
                aria-describedby="{id}-desc"
                onchange={(e) => commitNumber(s, e.currentTarget)}
              />
            {:else if s.kind === 'string'}
              <input
                {id}
                class="field"
                type="text"
                spellcheck="false"
                placeholder={s.placeholder ?? ''}
                value={s.value}
                aria-describedby="{id}-desc"
                onchange={(e) => save(s.key, e.currentTarget.value)}
              />
            {:else if s.kind === 'list' && s.options}
              <div class="options" role="group" aria-labelledby="{id}-label">
                {#each s.options as option (option)}
                  {@const on = (s.value as string[]).includes(option)}
                  <button type="button" class="option" class:on role="checkbox" aria-checked={on} onclick={() => toggleOption(s, option)}>
                    <span class="mark">{#if on}<Icon name="check" size={10} />{/if}</span>
                    <code>{option}</code>
                  </button>
                {/each}
              </div>
            {:else if s.kind === 'list'}
              {#if (s.value as string[]).length > 0}
                <ul class="items">
                  {#each s.value as string[] as item (item)}
                    <li>
                      <code>{item}</code>
                      <button
                        type="button"
                        class="remove"
                        aria-label="Remove {item}"
                        title="Remove"
                        onclick={() => save(s.key, (s.value as string[]).filter((v) => v !== item))}
                      ><Icon name="x" size={12} /></button>
                    </li>
                  {/each}
                </ul>
              {/if}
              <form class="add" onsubmit={(e) => addItem(s, e)}>
                <input
                  {id}
                  class="field"
                  type="text"
                  spellcheck="false"
                  placeholder={s.placeholder ?? ''}
                  aria-describedby="{id}-desc"
                  bind:value={adding[s.key]}
                />
                <button type="submit" class="secondary" disabled={!(adding[s.key] ?? '').trim()}><Icon name="plus" size={12} />Add</button>
              </form>
            {/if}
          </div>
        {/each}
      </section>
    {/each}
  {/if}
</Page>

<style>
  .group { display: flex; flex-direction: column; gap: 6px; }
  h3 {
    margin: 4px 0 0;
    font-size: 0.78em;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    opacity: 0.65;
  }
  .setting {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 10px;
    border-radius: 6px;
    border: 1px solid var(--ys-card-border);
    background: var(--ys-card);
  }
  .setting.changed { border-left: 2px solid var(--ys-accent); }
  .head { display: flex; align-items: center; gap: 8px; min-height: 20px; }
  .label { flex: 1; min-width: 0; font-weight: 600; }
  .scope {
    padding: 0 6px;
    border-radius: 8px;
    font-size: 0.78em;
    color: var(--ys-accent-text);
    background: var(--ys-accent-faint);
    border: 1px solid var(--ys-accent-border);
  }
  .reset { font-size: 0.82em; }
  .desc { margin: 0; font-size: 0.88em; line-height: 1.4; opacity: 0.75; overflow-wrap: anywhere; }
  code {
    font-family: var(--vscode-editor-font-family);
    font-size: 0.92em;
    padding: 0.05em 0.3em;
    border-radius: 3px;
    background: var(--vscode-textCodeBlock-background);
  }

  /* --- on/off switch ------------------------------------------------------- */
  .switch {
    position: relative;
    flex-shrink: 0;
    width: 30px;
    height: 16px;
    padding: 0;
    border-radius: 8px;
    border: 1px solid var(--ys-card-border);
    background: color-mix(in srgb, var(--vscode-foreground) 18%, transparent);
    cursor: pointer;
    transition: background 0.12s ease;
  }
  .switch.on { background: var(--ys-accent); border-color: var(--ys-accent); }
  .knob {
    position: absolute;
    top: 1px;
    left: 1px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--vscode-foreground);
    transition: transform 0.12s ease;
  }
  .switch.on .knob { transform: translateX(14px); background: var(--ys-on-accent); }
  @media (prefers-reduced-motion: reduce) { .switch, .knob { transition: none; } }

  /* --- text and number fields ---------------------------------------------- */
  .field {
    width: 100%;
    padding: 4px 8px;
    font: inherit;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--ys-card-border));
    border-radius: 4px;
  }
  .field.number { width: 110px; }
  .field:focus { outline: 1px solid var(--ys-accent); outline-offset: -1px; border-color: var(--ys-accent-border); }
  .field::placeholder { color: var(--vscode-input-placeholderForeground); }

  /* --- lists ---------------------------------------------------------------- */
  .items { display: flex; flex-wrap: wrap; gap: 4px; margin: 0; padding: 0; list-style: none; }
  .items li {
    display: flex;
    align-items: center;
    gap: 2px;
    max-width: 100%;
    padding: 1px 2px 1px 6px;
    border-radius: 10px;
    border: 1px solid var(--ys-accent-border);
    background: var(--ys-accent-faint);
  }
  .items code { background: none; padding: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .remove {
    display: flex;
    padding: 2px;
    color: inherit;
    background: none;
    border: none;
    border-radius: 50%;
    cursor: pointer;
    opacity: 0.7;
  }
  .remove:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
  .add { display: flex; gap: 6px; }
  .add .field { flex: 1; min-width: 0; }

  .options { display: flex; flex-direction: column; gap: 4px; }
  .option {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 6px;
    font: inherit;
    color: inherit;
    text-align: left;
    background: none;
    border: 1px solid var(--ys-card-border);
    border-radius: 4px;
    cursor: pointer;
  }
  .option:hover { background: var(--vscode-list-hoverBackground); }
  .option.on { border-color: var(--ys-accent-border); background: var(--ys-accent-faint); }
  .mark {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    border-radius: 3px;
    border: 1px solid var(--ys-card-border);
  }
  .option.on .mark { border-color: var(--ys-accent); background: var(--ys-accent); color: var(--ys-on-accent); }

  .muted { display: flex; align-items: center; gap: 6px; margin: 0; opacity: 0.7; }
</style>
