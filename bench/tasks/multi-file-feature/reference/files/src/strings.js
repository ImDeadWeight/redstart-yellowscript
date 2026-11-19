/** "barrel" -> "Barrel" */
export function capitalize(text) {
  return text ? text[0].toUpperCase() + text.slice(1) : text
}

/** Collapse runs of whitespace to one space and trim. */
export function squish(text) {
  return text.replace(/\s+/g, ' ').trim()
}

/** "  Hello, World!  " -> "hello-world" */
export function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}
