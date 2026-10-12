// heartbeat: whether an agent is alive, and working or waiting, judged from what its machine shows without asking the
// model, so no tokens are spent on it. The facts: whether its process lives (ProcessHost), when its tool last wrote the
// session's trace (tools.ts) and its last ringi command. What to do about a silent agent is the orchestrator's.

import {agentPorts} from '../ports/index.ts'
import {toolOf, traceTime} from './tools.ts'

// What a session shows at one moment.
export type Facts = {
  at: number                 // unix seconds of the look
  alive: boolean | null      // the session's process exists; null: no process known
  trace: number | null       // when its tool last wrote the session's trace
  seen: number               // its last ringi command
  stopped: boolean           // paused by the operator
  waits: string | null       // what its room keeps it waiting for (quorum), if anything
}
export type State = 'working' | 'waiting' | 'gone'
export type Beat = {state: State, waits: string | null, alive: boolean | null, quiet: number, next: number}

export type SessionLike = {handle: string, product: string | null, pid: number | null, lastSeen: string, state: string}
// The facts of one session now.
export const probe = (s: SessionLike, waits: string | null = null): Facts => ({
  at: Date.now() / 1000,
  alive: s.pid && agentPorts().host.supported ? agentPorts().host.alive(s.pid) : null,
  trace: traceTime(s),
  seen: Date.parse(s.lastSeen) / 1000,
  stopped: s.state === 'stopped', waits,
})
export const tracedBy = (s: Pick<SessionLike, 'handle' | 'product'>): string => toolOf(s)?.tool ?? 'none'

// working: its trace or a ringi command is younger than `active` seconds; waiting: alive but quiet, or kept waiting by
// the operator or its room; gone: its process is known to have ended.
export const judge = (cur: Facts, {active = 120, next = 30}: {active?: number, next?: number} = {}): Beat => {
  const quiet = Math.max(0, Math.round(cur.at - Math.max(cur.seen, cur.trace ?? 0)))
  const base = {alive: cur.alive, quiet, next}
  if (cur.alive === false) return {...base, state: 'gone', waits: null}
  if (cur.stopped) return {...base, state: 'waiting', waits: 'stopped'}
  if (cur.waits) return {...base, state: 'waiting', waits: cur.waits}
  return quiet < active ? {...base, state: 'working', waits: null} : {...base, state: 'waiting', waits: 'inbox'}
}

// The text of a heartbeat: facts as trailers, no word of the work itself.
export const body = (b: Beat): string => [
  `State: ${b.state}`,
  ...(b.waits ? [`Waits: ${b.waits}`] : []),
  `Alive: ${b.alive === null ? 'unknown' : b.alive ? 'yes' : 'no'}`,
  `Quiet: ${b.quiet}`,
  `Next: ${b.next}`,
].join('\n') + '\n'
