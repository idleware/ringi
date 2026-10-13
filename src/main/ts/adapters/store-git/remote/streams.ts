// Actor streams: immutable commit facts, room/control admission, and the verified prefix of a stream.
import * as C from '../../../lib/index.ts'
import * as P from '../../../core/hub/protocol/index.ts'
import {readCommits} from './commits.ts'
import {ancestor, reason, rev} from './git.ts'
import {chain} from './signature.ts'
import {streamDependencies} from './stream-control.ts'
import {checkStreamRecord} from './stream-check.ts'
import type {Facts, StreamKind} from './stream-facts.ts'
export type {StreamKind} from './stream-facts.ts'
import type {SignalEvent} from '../../../core/hub/ports/store.ts'
import type {Handle, Raw, Room} from './types.ts'

export const streamRoom = (H: Handle): Room => {
  const e = H.endpoint ?? C.fail('actor stream requires a selected room endpoint')
  const head = rev(H, 'refs/heads/chat') ?? C.fail('room chat is missing')
  return {name: e.name, genesis: e.genesis, ref: 'refs/heads/chat', head}
}
export const streamName = (ref: string): {actor: string, kind: StreamKind} | null => {
  const m = /^refs\/heads\/([^/]+)\/(signals|telemetry)$/.exec(ref)
  return m && P.ID_RE.test(m[1]) && !['main', 'chat'].includes(m[1]) ? {actor: m[1], kind: m[2] as StreamKind} : null
}
export const streamRef = (actor: string, kind: StreamKind): string => {
  const ref = `refs/heads/${actor}/${kind}`
  if (!streamName(ref)) C.fail(`bad stream actor ${actor}`)
  return ref
}
type Record_ = {raw: Raw, fields: Facts}
export type Stream = {head: string, records: Record_[], pending?: string, why?: string}
export type ScanInput = {H: Handle, R: Room, actor: string, kind: StreamKind, head: string, prefix?: Stream}
const scanSuffix = ({H, R, actor, kind, head, prefix}: ScanInput): Stream => {
  const result: Stream = {head: prefix?.head ?? R.genesis, records: [...prefix?.records ?? []]}
  const dep = streamDependencies(H, R)
  const list = chain(H, head, result.head)
  for (const c of readCommits(H, list.map(c => c.sha))) {
    try {
      const f = checkStreamRecord({H, R, actor, kind, parent: result.head, dep}, c)
      if (!f) {result.pending = c.sha; break}
      result.records.push({raw: c, fields: f})
      result.head = c.sha
    } catch (e) {result.why = `${c.sha.slice(0, 12)}: ${reason(e)}`; break}
  }
  if (!list.length && head !== result.head) result.why = 'stream does not descend from its room genesis'
  return result
}
// Valid facts are immutable. Reuse only a prefix whose chat and actor stream both still extend the last view.
const scanned = new WeakMap<Handle, Map<string, {seen: string, chat: string, stream: Stream}>>()
export const scanStream = ({H, R, actor, kind, head, prefix}: ScanInput): Stream => {
  const key = JSON.stringify([R.genesis, actor, kind, H.d.genesis, H.d.root, H.d.trust])
  const chat = rev(H, R.ref) ?? C.fail('room chat is missing')
  const cache = scanned.get(H) ?? new Map()
  scanned.set(H, cache)
  const old = cache.get(key)
  if (!prefix && old?.seen === head && old.chat === chat) return old.stream
  const base = prefix ?? (old && ancestor(H, old.chat, chat) && ancestor(H, old.stream.head, head) ? old.stream : undefined)
  const result = scanSuffix({H, R, actor, kind, head, prefix: base})
  if (kind === 'telemetry') result.records = result.records.slice(-1)
  cache.set(key, {seen: head, chat, stream: result})
  if (cache.size > 4096) cache.delete(cache.keys().next().value!)
  return result
}
export const signalEvents = (R: Room, actor: string, s: Stream): SignalEvent[] => s.records.map(({raw, fields}) => ({
  id: raw.sha, parent: raw.parents[0], roomGenesis: R.genesis, control: fields.get('Control')!, actor,
  target: fields.get('Target')!, signal: fields.get('Signal')!,
}))
export const validateStream = (H: Handle, R: Room, ref: string, head: string): void => {
  const name = streamName(ref) ?? C.fail('unknown actor stream')
  const s = scanStream({H, R, ...name, head})
  if (s.why || s.head !== head) C.fail(s.why ?? 'stream dependencies are not yet accepted')
}
