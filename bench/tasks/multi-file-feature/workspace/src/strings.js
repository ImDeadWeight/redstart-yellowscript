/** "barrel" -> "Barrel" */
export function capitalize(text) {
  return text ? text[0].toUpperCase() + text.slice(1) : text
}

/** Collapse runs of whitespace to one space and trim. */
export function squish(text) {
  return text.replace(/\s+/g, ' ').trim()
}
