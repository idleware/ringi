// context: who acts and where, as an interface asks for it (the operator in its terminal context, an agent through its
// session's binding), and what this build is.

import {HOME, OPERATOR, RESOURCES, VERSION, config} from '../home/index.ts'
import {CAPS, HUB_MAJOR, openHub, room as roomOf} from '../hub/index.ts'
import {bound} from '../runtime/session.ts'
import type {Session} from '../runtime/session.ts'
import type {Actor} from './room.ts'

// An actor, and for an agent the session it acts through.
export type Ctx = Actor & {s?: Session}
// The operator, in the named hub and room, else in the terminal's current ones.
export const operator = ({hub, room}: {hub?: string, room?: string} = {}): Ctx => {
  const H = openHub(hub ?? config().hub)
  const name = room ?? (hub && hub !== config().hub ? null : config().room)
  return {R: roomOf(H, name), me: OPERATOR}
}
// The agent this session is bound to; refuses when it is not joined, is stopped, or its room is gone.
export const agent = (): Ctx => bound()
export const about = () => ({version: VERSION, home: HOME, resources: RESOURCES, contract: `${HUB_MAJOR}.x`, capabilities: [...CAPS]})
export {config}
