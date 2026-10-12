// staging, like git's index: add takes a file's content into the store now, and the actor's next message carries it,
// whatever happens to the file meanwhile. Results and state travel only so, never through a shared directory. The store
// keeps staged contents reachable (`retain`); it grows before the list does and shrinks after, so a crash in between
// leaks an object rather than loses one.

import fs from 'node:fs'
import {fail} from '../../../lib/index.ts'
import {checkCollisions} from '../protocol/files.ts'
import type {Entry} from '../protocol/files.ts'
import {loadState, readerLock, saveState} from '../history/index.ts'
import type {Staged} from '../history/index.ts'
import type {Actor} from './actor.ts'

const FILE_MAX = 64 << 20
const tooBig = (path: string, size: number) => size > FILE_MAX && fail(`${path} is ${Math.ceil(size / (1 << 20))} MiB; an attachment is at most ${FILE_MAX >> 20} MiB`)
// What retain keeps: each staged content once, named by its id, so two snapshots of one path both stay.
const kept = (all: Staged[]): Entry[] => [...new Set(all.map(s => s.blob))].map(blob => ({path: blob, blob, mode: '100644'}))
export const staged = ({R, me}: Actor): Staged[] => loadState(R, me).staged ?? []
export const stage = ({R, me}: Actor, files: Entry[]): Staged[] => {
  const taken = files.map(e => {
    if (!e.file) fail(`${e.path}: add takes files`)
    tooBig(e.path, fs.statSync(e.file!).size)
    const b = R.hub.store.blob(e.file!)
    tooBig(e.path, b.size)
    return {path: e.path, blob: b.id, mode: e.mode, size: b.size}
  })
  return readerLock(R, me, () => {
    const st = loadState(R, me)
    const next = new Map((st.staged ?? []).map(s => [s.path, s]))
    for (const s of taken) next.set(s.path, s)
    const all = [...next.values()]
    checkCollisions(all.map(s => s.path))
    R.hub.store.retain(R.s, me, kept([...all, ...st.staged ?? []]))
    saveState(R, me, {...st, staged: all})
    R.hub.store.retain(R.s, me, kept(all))
    return all
  })
}
export const shrink = ({R, me}: Actor, keep: (s: Staged) => boolean): Staged[] => {
  const st = loadState(R, me)
  const left = (st.staged ?? []).filter(keep)
  saveState(R, me, {...st, staged: left})
  R.hub.store.retain(R.s, me, kept(left))
  return left
}
// Unstages the given paths, or everything.
export const unstage = (a: Actor, paths: string[] | null): Staged[] => readerLock(a.R, a.me, () => {
  const missing = (paths ?? []).filter(p => !staged(a).some(s => s.path === p))
  if (missing.length) fail(`not staged: ${missing.join(', ')}`)
  return shrink(a, s => paths !== null && !paths.includes(s.path))
})
// What the actor staged goes along, an explicit attachment of the same path in its place.
export const outgoing = (stagedNow: Staged[], explicit: Entry[]): Entry[] => {
  for (const e of explicit) if (e.file) tooBig(e.path, fs.statSync(e.file).size)
  const named = new Set(explicit.map(e => e.path))
  const entries: Entry[] = [...stagedNow.filter(s => !named.has(s.path)).map(s => ({path: s.path, blob: s.blob, mode: s.mode})), ...explicit]
  checkCollisions(entries.map(e => e.path))
  return entries
}
