// =============================================================================
// What a message can carry besides its text: images, files, selections.
// =============================================================================
// The person attaches; the bubble shows a chip; the model reads a block.
//
//   image      pasted or dropped, downscaled to ≤1,280px in the webview, at
//              most 4 a message; sent as image_url parts, and only when the
//              model reads images (llama-server's /props).
//   file       chosen with @; its content (up to 300 lines) or, when longer,
//              its outline, read by the host when the message is sent and
//              stored with it, so later requests repeat the same bytes.
//   selection  "Add to Yellowscript" in the editor: a path, a line range and
//              the text.
//
// Pure: validation, and the text the model reads. No `vscode`.
// =============================================================================

import type { AttachmentView } from './protocol.ts'

export const MAX_IMAGES = 4
export const MAX_IMAGE_EDGE = 1_280
/** A data URL's length at most: a 1,280px JPEG is well under this. */
export const MAX_IMAGE_DATA_URL = 3_000_000
export const MAX_FILE_LINES = 300
export const MAX_ATTACHMENTS = 12
const MAX_SELECTION_CHARS = 20_000

const IMAGE_URL = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/

/** What the webview sent, checked; anything malformed is dropped. */
export function parseAttachments(raw: unknown): AttachmentView[] {
  if (!Array.isArray(raw)) return []
  const out: AttachmentView[] = []
  let images = 0
  for (const item of raw.slice(0, MAX_ATTACHMENTS)) {
    if (typeof item !== 'object' || item === null) continue
    const a = item as Record<string, unknown>
    if (a.kind === 'image' && typeof a.dataUrl === 'string' && a.dataUrl.length <= MAX_IMAGE_DATA_URL && IMAGE_URL.test(a.dataUrl) && images < MAX_IMAGES) {
      images++
      out.push({ kind: 'image', name: typeof a.name === 'string' ? a.name.slice(0, 120) : 'image', dataUrl: a.dataUrl })
    } else if (a.kind === 'file' && typeof a.path === 'string' && a.path.trim()) {
      out.push({ kind: 'file', path: a.path.trim().slice(0, 500) })
    } else if (
      a.kind === 'selection' && typeof a.path === 'string' && typeof a.text === 'string' &&
      Number.isInteger(a.startLine) && Number.isInteger(a.endLine) && (a.startLine as number) >= 1 && (a.endLine as number) >= (a.startLine as number)
    ) {
      out.push({ kind: 'selection', path: a.path.slice(0, 500), startLine: a.startLine as number, endLine: a.endLine as number, text: a.text.slice(0, MAX_SELECTION_CHARS) })
    }
  }
  return out
}

/** The chip's label. */
export function attachmentLabel(a: AttachmentView): string {
  if (a.kind === 'image') return a.name
  if (a.kind === 'file') return `@${a.path}`
  return `${a.path}:${a.startLine}-${a.endLine}`
}

const fence = (text: string) => (text.includes('```') ? '````' : '```')

/** The block the model reads for a file or a selection. */
export function attachmentBlock(a: AttachmentView): string | null {
  if (a.kind === 'image') return null
  if (a.kind === 'selection') {
    const f = fence(a.text)
    return `[Selected: ${a.path} lines ${a.startLine}-${a.endLine}]\n${f}\n${a.text}\n${f}`
  }
  if (a.content === undefined) return `[Attached: ${a.path} — it could not be read]`
  const f = fence(a.content)
  const what = a.outline ? `${a.lines} lines; its outline, read a range with ys_read_file` : `${a.lines ?? '?'} lines`
  return `[Attached: ${a.path} (${what})]\n${f}\n${a.content}\n${f}`
}

export type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }

/**
 * A user message as the model reads it: the text, then each attached file
 * or selection as a block; images as image_url parts when the model reads
 * them, or a note saying one was attached when it does not.
 */
export function userContent(text: string, attachments: readonly AttachmentView[] | undefined, vision: boolean): string | ContentPart[] {
  if (!attachments?.length) return text
  const blocks = attachments.map(attachmentBlock).filter((b): b is string => b !== null)
  const images = attachments.filter((a): a is Extract<AttachmentView, { kind: 'image' }> => a.kind === 'image')
  const note = images.length && !vision ? [`[${images.length} image${images.length === 1 ? ' was' : 's were'} attached, but this model cannot read images.]`] : []
  const body = [text, ...blocks, ...note].filter(Boolean).join('\n\n')
  if (!images.length || !vision) return body
  return [{ type: 'text', text: body }, ...images.map((i) => ({ type: 'image_url' as const, image_url: { url: i.dataUrl } }))]
}
