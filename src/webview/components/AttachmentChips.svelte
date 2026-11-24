<script lang="ts">
  import type { AttachmentView } from '../../chat/protocol.ts'
  import { attachmentLabel } from '../../chat/attachments.ts'
  import Icon from './Icon.svelte'

  /** What goes with the next message, as chips that can be removed. */
  let {
    attachments,
    imagesBlocked = false,
    onRemove,
  }: { attachments: AttachmentView[]; imagesBlocked?: boolean; onRemove: (index: number) => void } = $props()
</script>

{#if attachments.length}
  <div class="attachments">
    {#each attachments as attachment, i (i)}
      <span class="attachment" title={attachment.kind === 'selection' ? attachment.text.slice(0, 400) : attachmentLabel(attachment)}>
        {#if attachment.kind === 'image'}
          <img src={attachment.dataUrl} alt={attachment.name} />
        {:else}
          <Icon name="file" size={12} />
        {/if}
        <span class="label">{attachmentLabel(attachment)}</span>
        <button type="button" class="remove" aria-label="Remove {attachmentLabel(attachment)}" onclick={() => onRemove(i)}>
          <Icon name="x" size={10} />
        </button>
      </span>
    {/each}
  </div>
  {#if imagesBlocked}
    <div class="note">This model cannot read images. Remove them to send, or load a model that can.</div>
  {/if}
{/if}

<style>
  .attachments { display: flex; flex-wrap: wrap; gap: 4px; padding: 6px 6px 0; }
  .attachment {
    display: flex;
    align-items: center;
    gap: 4px;
    max-width: 100%;
    padding: 2px 4px 2px 6px;
    font-size: 0.8em;
    border: 1px solid var(--ys-card-border);
    border-radius: 10px;
    background: var(--ys-card);
  }
  .attachment img { width: 28px; height: 28px; object-fit: cover; border-radius: 4px; }
  .attachment .label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .remove { display: flex; padding: 2px; color: inherit; background: none; border: none; border-radius: 50%; cursor: pointer; opacity: 0.6; }
  .remove:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
  .note { padding: 4px 8px 0; font-size: 0.8em; color: var(--vscode-editorWarning-foreground); }
</style>
