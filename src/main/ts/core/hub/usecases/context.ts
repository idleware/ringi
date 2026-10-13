// context: who acts as the operator and in which room (its terminal context, unless a command names one), and what
// this build is. An agent acts through its session (core/agents/sessions/context.ts).

import {hubPorts} from '../ports/index.ts'
import {CAPS, HUB_MAJOR, OPERATOR, config} from '../rooms/index.ts'
import {roomNamed} from './rooms.ts'
import type {Actor} from './actor.ts'

// The operator, in the named room, else in the terminal's current one.
export const operator = ({room}: {room?: string} = {}): Actor => ({R: roomNamed(room), me: OPERATOR})
export const about = () => ({version: hubPorts().build.version, home: hubPorts().state.root, resources: hubPorts().build.resources, contract: `${HUB_MAJOR}.x`, capabilities: [...CAPS]})
export {config}
