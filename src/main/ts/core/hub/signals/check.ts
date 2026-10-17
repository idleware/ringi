// Signals agree with the historical message fold; an invalid fact stops its actor's stream.
import type {All, Message} from '../protocol/index.ts'
import {effective} from './effective.ts'
import {markWhy} from './marks.ts'
import {MARKS} from './model.ts'
import type {Checked, RoomModel, SignalEvent} from './model.ts'

const meaning = (R: RoomModel, all: All, x: SignalEvent, m: Message): string | undefined => {
  if (x.roomGenesis !== R.genesis) return 'names another room genesis'
  if (MARKS.includes(x.signal)) return markWhy(R, x.actor, m, x.signal, R.membersAt?.(x.control))
  if (m.from !== x.actor) return `points at a message of ${m.from}`
  return effective(R, all, m).includes(x.signal) ? undefined : `its message did not make ${x.signal}`
}
export const check = (R: RoomModel, all: All, records: SignalEvent[]): Checked[] => {
  const stopped = new Set<string>(), tuples = new Set<string>()
  return records.map(x => {
    const m = all.get(x.target), pending = stopped.has(x.actor) || !m
    const why = pending ? 'awaits an accepted stream prefix and message' : meaning(R, all, x, m)
    if (why) stopped.add(x.actor)
    const tuple = JSON.stringify([x.actor, x.target, x.signal])
    const duplicate = tuples.has(tuple)
    if (!why) tuples.add(tuple)
    return {ref: x.id, actor: x.actor, signal: x.signal, target: x.target, ok: !why && !duplicate, why,
      ...((pending || duplicate) ? {pending: true} : {})}
  })
}
