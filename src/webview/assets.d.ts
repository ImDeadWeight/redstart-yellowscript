// esbuild imports .svg as text (esbuild.mjs, loader '.svg': 'text').
declare module '*.svg' {
  const markup: string
  export default markup
}
