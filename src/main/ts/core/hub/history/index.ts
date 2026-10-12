// reader: what one reader on this machine accepted of a room: heads, signals, cursors, alarms. Only history that
// extends what it accepted before, verified by the store, is delivered (docs/spec/hub-1.md, Trust).

import * as Signals from '../signals/index.ts'
import {hubPorts, locked} from '../ports/index.ts'
import {toMessage} from '../rooms/index.ts'
import type {Room} from '../rooms/index.ts'
import {fail, note, short} from '../../../lib/index.ts'
import {link} from '../protocol/index.ts'
import type {All, Logs} from '../protocol/index.ts'
import type {Rev} from '../ports/store.ts'

// One reader's record of one room has three owners, kept as one record.
// What the reader accepted of the room's history (history): its control head, each log's head, the stored objects of
// the signals it accepted (core/hub/signals), and the alarms already told.
export type Accepted = {
  control?: Rev
  heads?: Record<string, Rev>
  signals?: Record<string, string>
  alarms?: string[]
}
// What was delivered to it: the last message of each log it has seen.
export type Delivered = {
  seen?: Record<string, string>
}
// Files it staged for its next message (core/hub/usecases/staging.ts).
export type Outgoing = {
  staged?: Staged[]
}
export type ReaderState = Accepted & Delivered & Outgoing
export type Staged = {path: string, blob: string, mode: string, size: number}
// What one reader accepted of one room: a record of the machine's state.
const readerKey = (R: Room, reader: string) => ['readers', R.hub.name, R.genesis, reader]
export const readerLock = <T>(R: Room, reader: string, fn: () => T): T => locked(`reader-${R.hub.name}-${R.genesis.slice(0, 12)}-${reader}`, fn)
export const loadState = (R: Room, reader: string): ReaderState => hubPorts().state.read<ReaderState>(readerKey(R, reader), {})
export const saveState = (R: Room, reader: string, st: ReaderState): void => hubPorts().state.write(readerKey(R, reader), st)
// The control history must extend what this reader accepted; a rewritten one delivers nothing.
const acceptControl = (R: Room, st: ReaderState): void => {
  if (st.control && !R.hub.store.extends(st.control, R.head)) {
    fail(`ALARM room ${R.name}: its control history was rewritten (accepted ${short(st.control)}, now ${short(R.head)}). Nothing is delivered; the operator decides`)
  }
  st.control = R.head
}
// Why a log's current head cannot be accepted after `acc`, if it cannot.
const logProblem = (R: Room, id: string, acc: Rev, cur: Rev | null): string | null => {
  const store = R.hub.store
  if (!cur) return `log ${id} was deleted after ${short(acc)}`
  if (acc && !store.extends(acc, cur)) return `log ${id} was rewritten: ${short(cur)} does not extend the accepted ${short(acc)}`
  if (!store.extends(R.genesis, cur)) return `log ${id} does not descend from the room's genesis`
  const why = store.verifyLog(R.s, id, cur)
  return why && `log ${id}: ${why}`
}
// Every log that still extends its accepted head, pinned at its new head; the others become alarms.
const acceptLogs = (R: Room, reader: string, st: ReaderState, alarms: string[]): Logs => {
  const store = R.hub.store, heads = st.heads ??= {}
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
const acceptSignals = (R: Room, logs: Logs, st: ReaderState, alarms: string[]): void => {
  const records = R.hub.store.signals(R.s)
  const checked = Signals.check(R, link(logs), records)
  const signalPins = Signals.pins(records, checked, st.signals)
  st.signals = signalPins.accepted
  alarms.push(...signalPins.alarms, ...checked.filter(x => !x.ok).map(x => `signal ${x.ref}: ${x.why}`))
}
// What follows from an alarm, by what it is about.
const remedy = (R: Room, alarm: string): string => {
  if (alarm.startsWith('signal ')) return 'the messages stay the truth; the author restores a missing signal with ringi agent signals --repair'
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
  const alarms: string[] = [...R.hub.store.alarms?.(R.s) ?? []]
  const logs = acceptLogs(R, reader, st, alarms)
  acceptSignals(R, logs, st, alarms)
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
