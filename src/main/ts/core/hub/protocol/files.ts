// files: the paths a message may attach (core-1 §4).

import {fail} from '../../../lib/index.ts'

export const CC_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/
// An attachment: its content from a file, from text, or already in the store (`blob`).
export type Entry = {path: string, file?: string, content?: string, blob?: string, mode: string}
// A path component that is empty, a directory alias or git's own, too long, or holds control characters. git's own in
// any spelling a file system folds to it: any letter case, or with the code points HFS+ ignores.
const HFS_IGNORED = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g
const RESERVED = (c: string): boolean => ['', '.', '..', '.git'].includes(c.replace(HFS_IGNORED, '').toLowerCase())
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
const COMPONENT_BAD = (c: string): boolean => RESERVED(c) || Buffer.byteLength(c) > 255 || CONTROL.test(c)
export const checkPath = (p: string): string => {
  if (p.startsWith('/') || p.split('/').some(COMPONENT_BAD)) fail(`bad file path ${p}`)
  return p
}
export const checkCollisions = (paths: string[]): void => {
  const seen = new Map<string, string>()
  for (const p of paths) {
    const k = p.normalize('NFC').toLowerCase()
    if (seen.has(k) && seen.get(k) !== p) fail(`file paths collide: ${seen.get(k)} and ${p}`)
    seen.set(k, p)
  }
}