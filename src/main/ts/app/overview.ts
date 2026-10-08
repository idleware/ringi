// overview: where things stand for the operator: the hub, the room, who is in, open work and proposals, the latest
// messages, and new ones as they land; and the sessions of this machine.

import * as D from '../domain/decisions.ts'
import {OPERATOR, ensureHome, locked} from '../home/index.ts'
import {HIDDEN, openHub, room as roomOf} from '../hub/index.ts'
import type {Hub, Room} from '../hub/index.ts'
import {fail} from '../lib/index.ts'
import {ordered} from '../protocol/index.ts'
import type {All, Message} from '../protocol/index.ts'
import {linked} from '../runtime/reader.ts'
import {allSessions, dropSession, liveness, readSession} from '../runtime/session.ts'
import type {Session} from '../runtime/session.ts'
import {tasks} from './room.ts'
import type {TaskView} from './view.ts'

export type SessionView = Session & {liveness: ReturnType<typeof liveness>}
const sessionView = (s: Session): SessionView => ({...s, liveness: liveness(s)})
export type Where = {
  hub: Hub
  room: Room | null
  sessions: SessionView[]
  work: TaskView[]
  proposals: D.Proposal[]
  // The room as the operator reads it, and its visible messages in order.
  all: All
  messages: Message[]
}
export const where = (H: Hub, name: string | null): Where => {
  if (!name) return {hub: H, room: null, sessions: [], work: [], proposals: [], all: new Map(), messages: []}
  const R = roomOf(H, name)
  const {all} = linked(R, OPERATOR)
  return {hub: H, room: R, sessions: allSessions().filter(s => s.hub === H.name && s.genesis === R.genesis).map(sessionView),
    work: tasks({R, me: OPERATOR}).views, proposals: D.proposals(all, R.authorityAt).filter(x => ['open', 'overdue'].includes(x.state)),
    all, messages: ordered([...all.values()].filter(m => !(m.kind && HIDDEN.has(m.kind))))}
}
// The visible messages that landed since `seen` (which it extends), read afresh from the store.
export const arrived = (H: Hub, R: Room, seen: Set<string>): {all: All, messages: Message[]} => {
  const {all} = linked(roomOf(openHub(H.name, {refresh: true}), R.name), OPERATOR)
  const messages = ordered([...all.values()].filter(m => !seen.has(m.id) && !(m.kind && HIDDEN.has(m.kind))))
  for (const m of messages) seen.add(m.id)
  return {all, messages}
}
export const sessions = (): SessionView[] => {
  ensureHome()
  return allSessions().map(sessionView)
}
// The seat a session held becomes free.
export const forgetSession = (handle: string): void => locked('sessions', () => {
  if (!readSession(handle)) fail(`no session ${handle}`)
  dropSession(handle)
})
