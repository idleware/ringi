// migrate-readers: readers' pins of a 0.1 room's signals, planned and rewritten for the new signal names.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {fail, strictJson} from '../../lib/index.ts'
import {mkdirIn, writeJsonAtomic} from '../fs/index.ts'
import type {SignalMigration} from './migrate-signals.ts'

type ReaderState = Record<string, unknown> & {signals?: Record<string, string>}
type ReaderPlan = {file: string, text: string, st: ReaderState, next: Record<string, string>, changed: boolean}
const identityOf = (m: SignalMigration, original: string, object: string) => {
  const named = /(?:^|\/)([^/]+)\/((?:[0-9a-f]{40}|[0-9a-f]{64}))\.([a-z][a-z0-9.-]*)$/.exec(original)
  // An early reader lost the actor, but its exact pinned object can still prove it.
  const bare = /^((?:[0-9a-f]{40}|[0-9a-f]{64}))\.([a-z][a-z0-9.-]*)$/.exec(original)
  const identity = bare ? m.identities.get(object) : undefined
  const agrees = identity && identity.target === bare![1] && identity.signal === bare![2]
  if (bare && !agrees) fail(`ALARM accepted signal ${original} lost its verified identity; migration stopped`)
  return {key: named ? `${named[1]}.${named[3]}.${named[2].slice(0, 12)}` : identity?.key ?? original, named: !!named}
}
const acceptedSignal = (m: SignalMigration, original: string, object: string): [string, string] => {
  const {key, named} = identityOf(m, original, object), change = m.changes.get(key)
  if (named && !change) fail(`ALARM accepted signal ${original} is missing; migration stopped`)
  const currentName = /^[a-z0-9]+(?:[_-][a-z0-9]+)*\.[a-z][a-z0-9.-]*\.[0-9a-f]{12}$/.test(key)
  if (!change && currentName && m.liveTags.get(`refs/tags/${key}`) !== object) fail(`ALARM accepted signal ${original} is missing or replaced; migration stopped`)
  if (change && object !== change.before && object !== change.after) fail(`ALARM accepted signal ${original} was replaced; migration stopped`)
  return [key, change?.after ?? object]
}
export const planReader = (m: SignalMigration, file: string): ReaderPlan => {
  const text = fs.readFileSync(file, 'utf8'), st = strictJson<ReaderState>(text, file)
  if (typeof st.control === 'string' && !m.kept(st.control)) fail('ALARM room control lost accepted history; migration stopped')
  for (const sha of Object.values(st.heads as Record<string, string> ?? {})) {
    if (!m.kept(sha)) fail('ALARM room log lost accepted history; migration stopped')
  }
  const next: Record<string, string> = {}
  for (const [original, object] of Object.entries(st.signals ?? {})) {
    const [key, value] = acceptedSignal(m, original, object)
    if (next[key] && next[key] !== value) fail(`ALARM accepted signal ${key} has conflicting objects; migration stopped`)
    next[key] = value
  }
  return {file, text, st, next, changed: JSON.stringify(st.signals ?? {}) !== JSON.stringify(next)}
}
export const writeReader = ({s, genesis}: SignalMigration, p: ReaderPlan): void => {
  if (!p.changed) return
  const dir = path.join(s.home, 'migration', s.name, genesis, 'readers')
  mkdirIn(s.home, dir)
  const snapshot = path.join(dir, `${path.basename(p.file)}.${crypto.createHash('sha256').update(p.text).digest('hex')}`)
  if (!fs.existsSync(snapshot)) fs.writeFileSync(snapshot, p.text, {flag: 'wx', mode: 0o600})
  else if (fs.readFileSync(snapshot, 'utf8') !== p.text) fail('ALARM migration reader snapshot changed; migration stopped')
  writeJsonAtomic(p.file, {...p.st, signals: p.next})
}
