// heartbeat: whether an agent is alive, and working or waiting, judged from what its machine shows without asking the
// model, so no tokens are spent on it. The facts: its process and process tree (platform.ts), the trace its tool
// writes (tools.ts) and ringi's own session record. What to do about a silent or stuck agent is the orchestrator's.

import {SUPPORTED, alive, table, treeCpu} from './platform.ts'
import {toolOf, traceTime} from './tools.ts'

// What a session shows at one moment. `cpu` is counted only where the process is the session's own (a watcher and
// its turn); a chat's app process hosts other sessions too, so its trace speaks for it instead.
export type Facts = {
  at: number                 // unix seconds of the look
  alive: boolean | null      // the session's process exists; null: no process known
  cpu: number | null         // CPU seconds of its process tree
  trace: number | null       // when its tool last wrote the session's trace
  seen: number               // its last ringi command, or its watcher's last loop
  stopped: boolean           // paused by the operator
  waits: string | null       // what its room keeps it waiting for (quorum), if anything
}
export type State = 'working' | 'waiting' | 'gone'
export type Beat = {state: State, waits: string | null, alive: boolean | null, quiet: number, cpu: number | null, next: number}

export type SessionLike = {handle: string, product: string | null, pid: number | null, lastSeen: string, state: string}
// The facts of one session now; `rows` lets one `ps` call serve many sessions.
export const probe = (s: SessionLike, waits: string | null = null, rows = SUPPORTED ? table() : null): Facts => ({
  at: Date.now() / 1000,
  alive: s.pid && SUPPORTED ? alive(s.pid) : null,
  cpu: s.pid && s.product === 'watch' ? treeCpu(s.pid, rows) : null,
  trace: traceTime(s),
  seen: Date.parse(s.lastSeen) / 1000,
  stopped: s.state === 'stopped',
  waits,
})
export const tracedBy = (s: Pick<SessionLike, 'handle' | 'product'>): string => toolOf(s)?.tool ?? (s.product === 'watch' ? 'watch' : 'none')

// working: its process tree used CPU since the previous look, or its trace or a ringi command is younger than
// `active` seconds; waiting: alive but neither, or kept waiting by the operator or its room; gone: its process is
// known to have ended.
export const judge = (cur: Facts, prev: Facts | null = null, {active = 120, next = 30}: {active?: number, next?: number} = {}): Beat => {
  const quiet = Math.max(0, Math.round(cur.at - Math.max(cur.seen, cur.trace ?? 0)))
  const base = {alive: cur.alive, quiet, cpu: cur.cpu, next}
  if (cur.alive === false) return {...base, state: 'gone', waits: null}
  if (cur.stopped) return {...base, state: 'waiting', waits: 'stopped'}
  if (cur.waits) return {...base, state: 'waiting', waits: cur.waits}
  const spent = prev?.cpu != null && cur.cpu != null && cur.cpu - prev.cpu >= 0.05
  return spent || quiet < active ? {...base, state: 'working', waits: null} : {...base, state: 'waiting', waits: 'inbox'}
}

// The text of a heartbeat: facts as trailers, no word of the work itself.
export const body = (b: Beat): string => [
  `State: ${b.state}`,
  ...(b.waits ? [`Waits: ${b.waits}`] : []),
  `Alive: ${b.alive === null ? 'unknown' : b.alive ? 'yes' : 'no'}`,
  `Quiet: ${b.quiet}`,
  ...(b.cpu === null ? [] : [`CPU: ${b.cpu.toFixed(1)}`]),
  `Next: ${b.next}`,
].join('\n') + '\n'
