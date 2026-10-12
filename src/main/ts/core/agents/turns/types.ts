// types: what the watcher's modules share: its options and context, groups of messages, runs and reservations.

import type * as D from '../../hub/decisions/index.ts'
import type {Hub, Room} from '../../hub/rooms/index.ts'
import type {Message} from '../../hub/protocol/index.ts'
export type WatchOptions = {
  seat: string, exec: string, hub?: string, scope?: string, handoff?: boolean, once?: boolean, requireGrant?: boolean,
  interval?: number, from?: string[], maxHop?: number, maxRuns?: number, window?: number
}
export type WatchContext = {
  w: WatchOptions, H0: Hub, R0: Room, me: string, raw: string, handle: string, cmd: string,
  interval: number, allow: Set<string> | null, maxHop: number, maxRuns: number, span: number, runSeq: number,
  log: (line: string) => void
}
export type Group = {grant: string | null, msgs: Message[], task: Message | null}
export type Run = Group & {run?: string, timeout: number | null}
export type Reserve = {why?: string, lost?: boolean, wait?: boolean, exhausted?: boolean, gr?: D.Grant, run?: string}
export type Plan = {runs: Run[], hold: boolean, lost: boolean}
export type Planning = Plan & {ownRuns: number[], exhausted: Record<string, boolean>}
