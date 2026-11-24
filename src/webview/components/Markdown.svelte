<script lang="ts">
  import { renderMarkdown } from '../markdown.ts'

  /** Model text as markdown. renderMarkdown escapes the whole input before it
   *  emits a tag of its own (markdown.ts): the only safe way to put model
   *  text into {@html}. Re-rendered only when this block's text changes, so
   *  a streaming turn lays out its last block, not every one before it. */
  let { text, narration = false, cursor = false }: { text: string; narration?: boolean; cursor?: boolean } = $props()
  const html = $derived(renderMarkdown(text))
</script>

<div class="body" class:narration class:cursor>{@html html}</div>

<style>
  /* Text said on the way, between tool calls: there, but quieter than the answer. */
  .narration { opacity: 0.8; font-size: 0.95em; }
  .cursor > :global(:last-child)::after {
    content: '▍';
    animation: blink 1s steps(2, start) infinite;
    opacity: 0.7;
  }
  @keyframes blink { to { visibility: hidden; } }
  @media (prefers-reduced-motion: reduce) {
    .cursor > :global(:last-child)::after { animation: none; }
  }
</style>
