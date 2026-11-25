<script lang="ts">
  // The artifacts this turn's Nest tools made or changed (artifacts plan §11):
  // title, where it stands, and Open in Redstart, which opens the chat app's
  // page for it in the browser. The host opens only the link Nest put in the
  // tool result for that id; this sends the turn and the id, nothing else.
  import type { ArtifactCardView } from '../../chat/protocol.ts'
  import { post } from '../host.ts'
  import Icon from './Icon.svelte'

  let { turnId, artifacts }: { turnId: string; artifacts: ArtifactCardView[] } = $props()
</script>

<section class="artifacts" aria-label="Artifacts">
  {#each artifacts as a (a.id)}
    <div class="card">
      <Icon name="file" size={12} />
      <span class="title">{a.title ?? 'Artifact'}</span>
      <span class="rev">{a.revision === 'draft' ? 'draft, saved when this turn ends' : a.revision ? `revision ${a.revision}` : 'nothing saved yet'}</span>
      {#if a.url}
        <button type="button" class="link" title="Open it in Redstart, in your browser" onclick={() => post({ type: 'openArtifact', turnId, id: a.id })}>Open in Redstart</button>
      {/if}
    </div>
  {/each}
</section>

<style>
  .artifacts { display: flex; flex-direction: column; gap: 4px; }
  .card {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    font-size: 0.88em;
    border-radius: 4px;
    background: var(--ys-card);
    border: 1px solid var(--ys-card-border);
  }
  .title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rev { opacity: 0.75; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .link { background: none; border: none; color: var(--vscode-textLink-foreground); cursor: pointer; padding: 0; font: inherit; }
  .link:hover { text-decoration: underline; }
</style>
