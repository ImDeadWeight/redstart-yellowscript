<script lang="ts">
  // A small inline icon set: 16px strokes in currentColor, so every icon takes
  // the theme's colour. Inline so the webview needs no font or image request
  // (the CSP allows none it does not have to).
  type Name =
    | 'plus' | 'history' | 'stop' | 'send' | 'check' | 'x' | 'chevron-down' | 'chevron-up'
    | 'chevron-right' | 'list' | 'question' | 'tool' | 'alert' | 'circle' | 'circle-check'
    | 'circle-dot' | 'circle-minus' | 'spinner' | 'server' | 'refresh'

  let { name, size = 14, label }: { name: Name; size?: number; label?: string } = $props()

  const paths: Record<Name, string> = {
    plus: 'M8 3v10M3 8h10',
    history: 'M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v2.6h2.6M8 5v3.2l2 1.3',
    stop: 'M4.5 4.5h7v7h-7z',
    send: 'M2.5 8h9M8 4l4 4-4 4',
    check: 'M3 8.5l3.2 3L13 4.5',
    x: 'M4 4l8 8M12 4l-8 8',
    'chevron-down': 'M4 6l4 4 4-4',
    'chevron-up': 'M4 10l4-4 4 4',
    'chevron-right': 'M6 4l4 4-4 4',
    list: 'M6 4h7M6 8h7M6 12h7M3 4h.01M3 8h.01M3 12h.01',
    question: 'M8 14.5A6.5 6.5 0 1 0 8 1.5a6.5 6.5 0 0 0 0 13zM6.2 6.2a1.9 1.9 0 0 1 3.7.6c0 1.3-1.9 1.7-1.9 2.7M8 11.5h.01',
    tool: 'M9.6 2.6a3.2 3.2 0 0 0-4 4L2.5 9.7a1.2 1.2 0 0 0 0 1.7l2.1 2.1a1.2 1.2 0 0 0 1.7 0l3.1-3.1a3.2 3.2 0 0 0 4-4l-2 2-1.9-.4-.4-1.9z',
    alert: 'M8 2l6.5 11.5h-13zM8 6.5v3M8 11.6h.01',
    circle: 'M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11z',
    'circle-check': 'M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11zM5.5 8.2l1.7 1.6 3.3-3.3',
    'circle-dot': 'M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11zM8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z',
    'circle-minus': 'M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11zM5.5 8h5',
    spinner: 'M8 2a6 6 0 1 1-6 6',
    server: 'M3 3h10v4H3zM3 9h10v4H3zM5.5 5h.01M5.5 11h.01',
    refresh: 'M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3',
  }
</script>

<svg
  class="icon"
  class:spin={name === 'spinner'}
  width={size}
  height={size}
  viewBox="0 0 16 16"
  fill="none"
  stroke="currentColor"
  stroke-width="1.5"
  stroke-linecap="round"
  stroke-linejoin="round"
  role={label ? 'img' : undefined}
  aria-label={label}
  aria-hidden={label ? undefined : 'true'}
><path d={paths[name]} /></svg>

<style>
  .icon { flex-shrink: 0; display: block; }
  .spin { animation: spin 0.9s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
</style>
