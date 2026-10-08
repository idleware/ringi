// files: the paths a message may attach (core-1 §4).

import {fail} from '../lib/index.ts'


export const CC_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/
export type Entry = {path: string, file?: string, content?: string, mode: string}
const COMPONENT_BAD = (c: string) => !c || c === '.' || c === '..' || c === '.git' || Buffer.byteLength(c) > 255 || CC_RE.test(c) || /[\n\t]/.test(c)
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