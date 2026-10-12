// context: who acts as the operator and where (its terminal context, unless a command names a hub or a room), and what
// this build is. An agent acts through its session (core/agents/sessions/context.ts).

import {hubPorts} from '../ports/index.ts'
import {CAPS, HUB_MAJOR, OPERATOR, config, openHub, room as roomOf} from '../rooms/index.ts'
import type {Actor} from './actor.ts'

// The operator, in the named hub and room, else in the terminal's current ones.
export const operator = ({hub, room}: {hub?: string, room?: string} = {}): Actor => {
  const H = openHub(hub ?? config().hub)
  const name = room ?? (hub && hub !== config().hub ? null : config().room)
  return {R: roomOf(H, name), me: OPERATOR}
}
export const about = () => ({version: hubPorts().build.version, home: hubPorts().state.root, resources: hubPorts().build.resources, contract: `${HUB_MAJOR}.x`, capabilities: [...CAPS]})
export {config}
