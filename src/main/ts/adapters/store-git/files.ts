// files: which files a message carries — the explicit Ringi-Files list, or for records without one the paths its
// commit adds or changes — and which it refuses.

import {checkCollisions, checkPath} from '../../core/hub/protocol/files.ts'
import {parse} from '../../core/hub/protocol/index.ts'
import type {StoredMessage} from '../../core/hub/ports/store.ts'
import {splitBuf} from './run.ts'

type File = {path: string, mode: string}
const REGULAR = new Set(['100644', '100755'])
const RAW = /^:\d{6} (\d{6}) \S+ \S+ ([A-Z])\d*\t(.*)$/
const TREE = /^(\d+) \w+ [0-9a-f]+\t(.*)$/s
const INVALID = {path: 'Ringi-Files', mode: 'invalid', why: 'expected one JSON array of safe, distinct file paths'}

// The paths a commit adds or changes over its parent (`git log --raw`).
const changed = (raw: string): File[] => raw.split('\n').map(l => RAW.exec(l)).filter((x): x is RegExpExecArray => !!x)
  .filter(([, , status]) => status !== 'D').map(([, mode, , p]) => ({path: p, mode}))
// The Ringi-Files list's paths, or null when it is not one JSON array of safe, distinct paths.
const declaredPaths = (declared: string[]): string[] | null => {
  try {
    const paths: unknown = JSON.parse(declared[0])
    if (declared.length !== 1 || !Array.isArray(paths) || !paths.every(p => typeof p === 'string')) return null
    const names = (paths as string[]).map(checkPath)
    checkCollisions(names)
    return new Set(names).size === names.length ? names : null
  } catch { return null }
}
// The declared paths as the commit's tree holds them; one the tree lacks is `missing`.
const inTree = (names: string[], tree: Buffer): File[] => {
  const wanted = new Set(names)
  const found = splitBuf(tree, 0).map(b => TREE.exec(b.toString('utf8'))).filter((x): x is RegExpExecArray => !!x)
    .map(([, mode, p]) => ({path: p, mode})).filter(f => wanted.has(f.path))
  for (const f of found) wanted.delete(f.path)
  return [...found, ...[...wanted].map(p => ({path: p, mode: 'missing'}))]
}
const listed = (declared: string[], sha: string, lsTree: (sha: string) => Buffer): {all: File[], refused: StoredMessage['refused']} => {
  const names = declaredPaths(declared)
  if (!names) return {all: [], refused: [INVALID]}
  return {all: names.length ? inTree(names, lsTree(sha)) : [], refused: []}
}
// A message's regular files, and what it refuses: an invalid list, a link, a missing file.
export const messageFiles = (body: Buffer, rest: Buffer, sha: string, isRef: (s: string) => boolean, lsTree: (sha: string) => Buffer):
  Pick<StoredMessage, 'files' | 'refused'> => {
  const declared = parse(body.toString('utf8'), isRef).trailers['ringi-files']
  const {all, refused} = declared ? listed(declared, sha, lsTree) : {all: changed(rest.toString('utf8')), refused: []}
  return {files: all.filter(f => REGULAR.has(f.mode)), refused: [...refused, ...all.filter(f => !REGULAR.has(f.mode))]}
}
