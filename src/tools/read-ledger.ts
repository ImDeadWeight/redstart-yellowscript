// =============================================================================
// Which version of a file the model has seen, in this run.
// =============================================================================
// 15 of the 44 failed ys_replace calls in the redstart-website chats copied
// old_string from a read made before the file changed, most often by the
// model's own edit a few calls earlier. "Not found" did not say so.
//
// ys_read_file notes the content it returned, and a planned write notes the
// content the file will hold once it is approved, so ys_replace can say
// "changed since you read it" or "not read in this run" when it fails.
//
// Kept per run: keyed on the run's ToolContext, which the loop passes to every
// call and which ends with the run. Hashes, not content.
// =============================================================================

import { createHash } from 'node:crypto'
import * as path from 'node:path'

import type { ToolContext } from './types.ts'

const seen = new WeakMap<ToolContext, Map<string, Set<string>>>()

const keyOf = (absolute: string) => {
  const resolved = path.resolve(absolute)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}
const hashOf = (content: string) => createHash('sha1').update(content.replace(/\r\n/g, '\n')).digest('hex')

/** The model has seen (or will see, once applied) this content of the file. */
export function noteSeen(context: ToolContext, absolute: string, content: string): void {
  let files = seen.get(context)
  if (!files) seen.set(context, (files = new Map()))
  const key = keyOf(absolute)
  const versions = files.get(key) ?? new Set<string>()
  versions.add(hashOf(content))
  files.set(key, versions)
}

/** Whether the file as it is now is a version the model has seen in this run. */
export function seenState(context: ToolContext, absolute: string, content: string): 'unread' | 'current' | 'changed' {
  const versions = seen.get(context)?.get(keyOf(absolute))
  if (!versions) return 'unread'
  return versions.has(hashOf(content)) ? 'current' : 'changed'
}
