// =============================================================================
// Images the person attaches: pasted, dropped, or picked from disk.
// =============================================================================
// Read in the webview and downscaled here, so a 12-megapixel photo goes to the
// host (and the model) as at most 1,280px on its longer edge.
// =============================================================================

import type { AttachmentView } from '../chat/protocol.ts'
import { MAX_IMAGES } from '../chat/attachments.ts'
import { fitWithin } from './view-model.ts'

type ImageAttachment = Extract<AttachmentView, { kind: 'image' }>

/** An image file, downscaled to 1,280px at most, as a data URL. */
export async function readImage(file: File): Promise<ImageAttachment> {
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
  const img = new Image()
  await new Promise((resolve, reject) => {
    img.onload = resolve
    img.onerror = reject
    img.src = url
  })
  const { width, height } = fitWithin(img.naturalWidth, img.naturalHeight)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  canvas.getContext('2d')?.drawImage(img, 0, 0, width, height)
  // PNG keeps a small screenshot sharp; anything bigger goes as JPEG.
  const dataUrl = file.type === 'image/png' && width * height <= 600_000 ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.85)
  return { kind: 'image', name: file.name || 'pasted image', dataUrl }
}

/** The image files among `files`. */
export function imageFiles(files: Iterable<File> | ArrayLike<File> | null | undefined): File[] {
  return files ? [...Array.from(files)].filter((f) => f.type.startsWith('image/')) : []
}

/** `attachments` with the images among `files` added, up to MAX_IMAGES in all.
 *  One that cannot be read is skipped. */
export async function withImages(attachments: readonly AttachmentView[], files: readonly File[]): Promise<AttachmentView[]> {
  let out = [...attachments]
  for (const file of imageFiles(files)) {
    if (out.filter((a) => a.kind === 'image').length >= MAX_IMAGES) break
    const image = await readImage(file).catch(() => null)
    if (image) out = [...out, image]
  }
  return out
}
