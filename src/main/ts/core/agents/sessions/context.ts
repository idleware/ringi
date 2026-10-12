// context: who acts as an agent — the agent this session is bound to — and what the agent tools this machine
// knows need from an interface: where they read skills, and what lets their sandboxes write.

import {agentPorts} from '../ports/index.ts'
import {bound} from './index.ts'
import type {Session} from './index.ts'
import type {Actor} from '../../hub/usecases/actor.ts'

// An actor, and for an agent the session it acts through.
export type Ctx = Actor & {s?: Session}
// The agent this session is bound to; refuses when it is not joined, is stopped, or its room is gone.
export const agent = (): Ctx => bound()
// Where the agent tools this machine knows read skills, under a base directory (the user's home or a project).
export const skillDirs = (base: string): string[] => agentPorts().tools.flatMap(t => t.skillDirs?.(base) ?? [])
// What lets each tool's sandbox write a path.
export const sandboxHints = (where: string): string[] => agentPorts().tools.flatMap(t => t.sandboxHint ? [t.sandboxHint(where)] : [])
