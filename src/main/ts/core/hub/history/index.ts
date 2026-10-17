// reader: what one reader on this machine accepted of a room: heads, signals, cursors, alarms. Only history that
// extends what it accepted before, verified by the store, is delivered (docs/spec/hub-1.md, Trust).

import * as Signals from '../signals/index.ts'
import {hubPorts, locked} from '../ports/index.ts'
import {isRegisteredRoom, registeredRoomLock, roomContextKey, toMessage} from '../rooms/index.ts'
import type {Room} from '../rooms/index.ts'
import {fail, note, short} from '../../../lib/index.ts'
import {link} from '../protocol/index.ts'
import type {All, Logs} from '../protocol/index.ts'
import type {Rev, StoreV4} from '../ports/store.ts'
import {closeFrontiers, eligible} from './retire.ts'
import type {Frontier} from './retire.ts'

// One reader's record of one room has three owners, kept as one record.
// What the reader accepted of the room's history (history): its control head, each log's head, the stored objects of
// the signals it accepted (core/hub/signals), and the alarms already told.
export type Accepted = {
  control?: Rev
  heads?: Record<string, Rev>
  signals?: Record<string, string>
  // The streams of removed actors, closed where this reader stood when it learned of the removal (retire.ts).
  retired?: Frontier
  alarms?: string[]
}
// What was delivered to it: the last message of each log it has seen.
export type Delivered = {
  seen?: Record<string, string>
}
export type ReaderState = Accepted & Delivered
// What one reader accepted of one room: a record of the machine's state, under the room's full context (its
// address, history and the repository it was read from), so a copy or a room made anew starts its own.
export const readersKey = (R: Room) => isRegisteredRoom(R) ? roomContextKey(R, 'readers') : ['readers', R.hub.d.genesis, R.genesis]
const readerKey = (R: Room, reader: string) => isRegisteredRoom(R) ? roomContextKey(R, 'readers', reader) : [...readersKey(R), reader]
export const readerLock = <T>(R: Room, reader: string, fn: () => T): T =>
  locked(isRegisteredRoom(R) ? `${registeredRoomLock(R)}-reader-${reader}` : `reader-${R.hub.d.genesis}-${R.genesis}-${reader}`, fn)
export const loadState = (R: Room, reader: string): ReaderState => hubPorts().state.read<ReaderState>(readerKey(R, reader), {})
export const saveState = (R: Room, reader: string, st: ReaderState): void => hubPorts().state.write(readerKey(R, reader), st)
// The control history must extend what this reader accepted; a rewritten one delivers nothing.
const acceptControl = (R: Room, st: ReaderState): void => {
  if (st.control && !R.store.extends(st.control, R.head)) {
    fail(`ALARM room ${R.name}: its control history was rewritten (accepted ${short(st.control)}, now ${short(R.head)}). Nothing is delivered; the operator decides`)
  }
  st.control = R.head
}
// Why a log's current head cannot be accepted after `acc`, if it cannot.
const logProblem = (R: Room, id: string, acc: Rev, cur: Rev | null): string | null => {
  const store = R.store
  if (!cur) return `log ${id} was deleted after ${short(acc)}`
  if (acc && !store.extends(acc, cur)) return `log ${id} was rewritten: ${short(cur)} does not extend the accepted ${short(acc)}`
  if (!store.extends(R.genesis, cur)) return `log ${id} does not descend from the room's genesis`
  const why = store.verifyLog(R.s, id, cur)
  return why && `log ${id}: ${why}`
}
// Every log that still extends its accepted head, pinned at its new head; the others become alarms.
const acceptLogs = (R: Room, reader: string, st: ReaderState, alarms: string[]): Logs => {
  const store = R.store, heads = st.heads ??= {}
  const logs: Logs = new Map()
  for (const id of new Set([...store.logIds(R.s), ...Object.keys(heads)])) {
    const cur = store.logHead(R.s, id), acc = heads[id]
    const why = logProblem(R, id, acc, cur)
    if (why) { alarms.push(why); continue }
    if (acc !== cur) { heads[id] = cur!; store.pin(R.s, reader, id, cur!) }
    logs.set(id, store.messages(R.s, id, cur!).map((x, seq) => toMessage(R, id, x, seq)))
  }
  return logs
}
// The signals that agree with their messages are pinned; the rest become alarms.
// This reader's signal records: a removed actor's only as far as its frontier, closed now if it is new.
export const readerSignals = (R: Room, st: ReaderState) => {
  st.retired = closeFrontiers((R.store as StoreV4).retirements?.(R.s) ?? {}, st.signals, st.retired)
  return eligible(R.store.signals(R.s), st.retired)
}
const acceptSignals = (R: Room, logs: Logs, st: ReaderState, alarms: string[], reader: string): void => {
  const records = readerSignals(R, st)
  const checked = Signals.check(R, link(logs), records)
  const signalPins = Signals.pins(records, checked, st.signals)
  const heads = new Map(R.store.signalHeads(R.s).map(x => [x.actor, x.head]))
  for (const [actor, old] of Object.entries(st.signals ?? {})) {
    const head = heads.get(actor)
    if (!head || !R.store.extends(old, head)) {
      alarms.push(`signal stream ${actor} was deleted or rewritten after ${short(old)}`)
      signalPins.accepted[actor] = old
    }
  }
  for (const [actor, head] of Object.entries(signalPins.accepted)) if (st.signals?.[actor] !== head) R.store.pinSignals(R.s, reader, actor, head)
  st.signals = signalPins.accepted
  alarms.push(...signalPins.alarms, ...checked.filter(x => !x.ok && !x.pending).map(x => `signal ${x.ref}: ${x.why}`))
}
// What follows from an alarm, by what it is about.
const remedy = (R: Room, alarm: string): string => {
  if (alarm.startsWith('signal ')) return 'the affected stream stops at its accepted prefix; messages stay the truth; the operator decides'
  if (alarm.startsWith('commit ')) return 'it is skipped; the room reads on without it'
  return `it is quarantined and withheld. Restore it, or the operator runs ringi forget ${R.name}/<log>`
}
// Every log must keep extending what this reader accepted, and the store must verify it (a signed store: every entry
// signed by the key the room admitted). A log that lost, rewrote or forked accepted history, or fails verification,
// is quarantined: withheld, its accepted head pinned as evidence. Only `ringi forget` by the operator accepts a new
// baseline. Each alarm is told once.
export const loadRoomUnlocked = (R: Room, reader: string): {logs: Logs, st: ReaderState} => {
  const st = loadState(R, reader)
  acceptControl(R, st)
  const alarms: string[] = [...R.store.alarms?.(R.s) ?? []]
  const logs = acceptLogs(R, reader, st, alarms)
  acceptSignals(R, logs, st, alarms, reader)
  alarms.push(...R.store.alarms?.(R.s) ?? [])
  const reported = new Set(st.alarms ?? [])
  for (const a of alarms) if (!reported.has(a)) note(`ALARM ${a}; ${remedy(R, a)}`)
  st.alarms = alarms
  saveState(R, reader, st)
  return {logs, st}
}
export const loadRoom = (R: Room, reader: string) => readerLock(R, reader, () => loadRoomUnlocked(R, reader))
export const linked = (R: Room, reader: string): {logs: Logs, all: All} => {
  const {logs} = loadRoom(R, reader)
  return {logs, all: link(logs)}
}
