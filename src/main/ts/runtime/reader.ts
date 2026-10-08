// reader: what one reader on this machine accepted of a room: heads, signals, cursors, alarms. Only history that
// extends what it accepted before, verified by the store, is delivered (docs/spec/hub-1.md, Trust).

import path from 'node:path'
import * as Signals from '../domain/signals.ts'
import {HOME, locked, readJson, writeJson} from '../home/index.ts'
import {toMessage} from '../hub/index.ts'
import type {Room} from '../hub/index.ts'
import {fail, note, short} from '../lib/index.ts'
import {link} from '../protocol/index.ts'
import type {All, Logs} from '../protocol/index.ts'
import type {Rev} from '../store/index.ts'

export type ReaderState = {
  control?: Rev
  heads?: Record<string, Rev>
  alarms?: string[]
  seen?: Record<string, string>
  watched?: Record<string, string>
  pending?: string[] // Scheduled wakeups remain here until their turn succeeds.
  inflight?: {seen: Record<string, string>} // A failed/crashed turn may deliver its inbox again.
  heartbeatSeen?: Record<string, string>
  runs?: number[]
  exhausted?: Record<string, boolean>
  // Stored objects of the signals this reader accepted (signals.ts).
  signals?: Record<string, string>
}
export const readerFile = (R: Room, reader: string): string => path.join(HOME, 'readers', R.hub.name, R.genesis, `${reader}.json`)
export const readerLock = <T>(R: Room, reader: string, fn: () => T): T => locked(`reader-${R.hub.name}-${R.genesis.slice(0, 12)}-${reader}`, fn)
export const loadState = (R: Room, reader: string): ReaderState => readJson<ReaderState>(readerFile(R, reader), {})
export const saveState = (R: Room, reader: string, st: ReaderState): void => writeJson(readerFile(R, reader), st)
// Every log must keep extending what this reader accepted, and the store must verify it (a signed store: every entry
// signed by the key the room admitted). A log that lost, rewrote or forked accepted history, or fails verification,
// is quarantined: withheld, its accepted head pinned as evidence. Only `ringi forget` by the operator accepts a new
// baseline.
export const loadRoomUnlocked = (R: Room, reader: string): {logs: Logs, st: ReaderState} => {
  const st = loadState(R, reader)
  const store = R.hub.store
  if (st.control && !store.extends(st.control, R.head)) {
    fail(`ALARM room ${R.name}: its control history was rewritten (accepted ${short(st.control)}, now ${short(R.head)}). Nothing is delivered; the operator decides`)
  }
  st.control = R.head
  st.heads ??= {}
  const alarms: string[] = []
  const logs: Logs = new Map()
  for (const id of new Set([...store.logIds(R.s), ...Object.keys(st.heads)])) {
    const cur = store.logHead(R.s, id)
    const acc = st.heads[id]
    const why = !cur ? `log ${id} was deleted after ${short(acc)}`
      : acc && !store.extends(acc, cur) ? `log ${id} was rewritten: ${short(cur)} does not extend the accepted ${short(acc)}`
        : !store.extends(R.genesis, cur) ? `log ${id} does not descend from the room's genesis`
          : store.verifyLog(R.s, id, cur)
    if (why) {
      alarms.push(why.startsWith('log ') ? why : `log ${id}: ${why}`)
      continue
    }
    if (acc !== cur) {
      st.heads[id] = cur!
      store.pin(R.s, reader, id, cur!)
    }
    logs.set(id, store.messages(R.s, id, cur!).map((x, seq) => toMessage(R, id, x, seq)))
  }
  const records = store.signals(R.s)
  const checked = Signals.check(R, link(logs), records)
  const signalPins = Signals.pins(records, checked, st.signals)
  st.signals = signalPins.accepted
  alarms.push(...signalPins.alarms, ...checked.filter(x => !x.ok).map(x => `signal ${x.ref}: ${x.why}`))
  const reported = new Set(st.alarms ?? [])
  for (const a of alarms) if (!reported.has(a)) note(`ALARM ${a}; ${a.startsWith('signal ')
    ? 'the messages stay the truth; the author restores a missing signal with ringi agent signals --repair'
    : `it is quarantined and withheld. Restore it, or the operator runs ringi forget ${R.name}/<log>`}`)
  st.alarms = alarms
  saveState(R, reader, st)
  return {logs, st}
}
export const loadRoom = (R: Room, reader: string) => readerLock(R, reader, () => loadRoomUnlocked(R, reader))
export const linked = (R: Room, reader: string): {logs: Logs, all: All} => {
  const {logs} = loadRoom(R, reader)
  return {logs, all: link(logs)}
}
