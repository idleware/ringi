// overview: where things stand for the operator: the hub, the room, who is in, open work, the latest
// messages, and new ones as they land; and the rooms of this machine.

import {HIDDEN, OPERATOR, openHub, room as roomOf} from '../hub/rooms/index.ts'
import type {Room} from '../hub/rooms/index.ts'
import {ordered} from '../hub/protocol/index.ts'
import type {All, Message} from '../hub/protocol/index.ts'
import {linked} from '../hub/history/index.ts'
import {allSessions, liveness} from './sessions/index.ts'
import type {Session} from './sessions/index.ts'
import {tasks} from '../hub/usecases/room.ts'
import {roomNamed, rooms} from '../hub/usecases/rooms.ts'
import type {RoomView} from '../hub/usecases/rooms.ts'
import type {TaskView} from '../hub/usecases/view.ts'

export type SessionView = Session & {liveness: ReturnType<typeof liveness>}
const sessionView = (s: Session): SessionView => ({...s, liveness: liveness(s)})
export type Where = {
  room: Room | null
  sessions: SessionView[]
  work: TaskView[]
  // The room as the operator reads it, and its visible messages in order.
  all: All
  messages: Message[]
}
export const where = (name: string | null): Where => {
  if (!name) return {room: null, sessions: [], work: [], all: new Map(), messages: []}
  const R = roomNamed(name)
  const {all} = linked(R, OPERATOR)
  return {room: R, sessions: allSessions().filter(s => s.genesis === R.genesis).map(sessionView),
    work: tasks({R, me: OPERATOR}).views,
    all, messages: ordered([...all.values()].filter(m => !(m.kind && HIDDEN.has(m.kind))))}
}
// The visible messages that landed since `seen` (which it extends), read afresh from the store.
export const arrived = (R: Room, seen: Set<string>): {all: All, messages: Message[]} => {
  const {all} = linked(roomOf(openHub(R.hub.name, {refresh: true}), R.name), OPERATOR)
  const messages = ordered([...all.values()].filter(m => !seen.has(m.id) && !(m.kind && HIDDEN.has(m.kind))))
  for (const m of messages) seen.add(m.id)
  return {all, messages}
}
// The rooms on this machine, each with how many of its sessions here are active.
export const roomsActive = (): Array<RoomView & {active: number}> => {
  const ss = allSessions().filter(s => liveness(s) === 'active')
  return rooms().map(v => ({...v, active: ss.filter(s => s.genesis === v.genesis).length}))
}
