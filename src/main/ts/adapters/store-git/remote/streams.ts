// Actor streams: immutable commit facts, room/control admission, and the verified prefix of a stream.
import * as C from '../../../lib/index.ts'
import * as P from '../../../core/hub/protocol/index.ts'
import {readCommits} from './commits.ts'
import {ancestor, reason, rev} from './git.ts'
import {chain} from './signature.ts'
import {streamDependencies} from './stream-control.ts'
import {checkStreamRecord} from './stream-check.ts'
import type {CheckContext} from './stream-check.ts'
import {isInvalidStream} from './stream-invalid.ts'
import {missingStreamEvidence, streamEvidence} from './stream-evidence.ts'
import type {Facts} from './stream-facts.ts'
import type {SignalEvent} from '../../../core/hub/ports/store.ts'
import type {Handle, Raw, Room} from './types.ts'

export const streamRoom = (H: Handle): Room => {
  const e = H.endpoint ?? C.fail('actor stream requires a selected room endpoint')
  const head = rev(H, 'refs/heads/chat') ?? C.fail('room chat is missing')
  return {name: e.name, genesis: e.genesis, ref: 'refs/heads/chat', head}
}
const actorName = (match: RegExpExecArray | null): {actor: string} | null =>
  match && P.ID_RE.test(match[1]) && !['main', 'chat'].includes(match[1]) ? {actor: match[1]} : null
export const streamName = (ref: string): {actor: string} | null => actorName(/^refs\/heads\/([^/]+)\/signals$/.exec(ref))
// Legacy evidence stays on disk; it is not a supported stream or an alarm in the current transport view.
export const legacyTelemetry = (ref: string): boolean => !!actorName(/^refs\/heads\/([^/]+)\/telemetry$/.exec(ref))
export const streamRef = (actor: string): string => {
  const ref = `refs/heads/${actor}/signals`
  if (!streamName(ref)) C.fail(`bad stream actor ${actor}`)
  return ref
}
type Record_ = {raw: Raw, fields: Facts}
export type Stream = {head: string, records: Record_[], pending?: string, why?: string}
export type ScanInput = {H: Handle, R: Room, actor: string, head: string, prefix?: Stream}
const acceptRecord = (ctx: Omit<CheckContext, 'parent'>, c: Raw, result: Stream): boolean => {
  try {
    const fields = checkStreamRecord({...ctx, parent: result.head}, c)
    if (!fields) {result.pending = c.sha; return false}
    result.records.push({raw: c, fields})
    result.head = c.sha
    return true
  } catch (e) {
    if (!ctx.dep.retired?.has(ctx.actor) || !isInvalidStream(e)) result.why = `${c.sha.slice(0, 12)}: ${reason(e)}`
    return false
  }
}
const scanSuffix = ({H, R, actor, head, prefix}: ScanInput): Stream => {
  const result: Stream = {head: prefix?.head ?? R.genesis, records: [...prefix?.records ?? []]}
  const dep = streamDependencies(H, R)
  const list = chain(H, head, result.head)
  for (const c of readCommits(H, list.map(c => c.sha))) {
    if (!acceptRecord({H, R, actor, dep}, c, result)) break
  }
  if (!list.length && head !== result.head) result.why = 'stream does not descend from its room genesis'
  return result
}
// Valid facts are immutable. Reuse only a prefix whose chat and actor stream both still extend the last view.
const scanned = new WeakMap<Handle, Map<string, {seen: string, chat: string, stream: Stream}>>()
const withEvidence = ({H, R, actor}: ScanInput, pins: string[], stream: Stream): Stream => {
  const pin = missingStreamEvidence(H, pins, stream.head)
  // Quarantine this stream's view, retaining its evidence and allowing other actors to be read.
  return pin ? {head: R.genesis, records: [], why: `signal stream ${actor} does not include its accepted prefix ${pin}`} : stream
}
export const scanStream = ({H, R, actor, head, prefix}: ScanInput): Stream => {
  const input = {H, R, actor, head, prefix}
  const pins = streamEvidence(H, R).get(actor) ?? []
  const raw = withEvidence(input, pins, {head, records: []})
  if (raw.why) return raw
  const key = JSON.stringify([R.genesis, actor, H.d.genesis, H.d.root, H.d.trust])
  const chat = rev(H, R.ref) ?? C.fail('room chat is missing')
  const cache = scanned.get(H) ?? new Map()
  scanned.set(H, cache)
  const old = cache.get(key)
  if (!prefix && old?.seen === head && old.chat === chat) {
    return withEvidence(input, pins, old.stream)
  }
  const base = prefix ?? (old && ancestor(H, old.chat, chat) && ancestor(H, old.stream.head, head) ? old.stream : undefined)
  // Even on a retired stream, its retained prefix must still validate. No suffix policy can waive reader evidence.
  const result = withEvidence(input, pins, scanSuffix({...input, prefix: base}))
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
