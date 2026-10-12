// heartbeat: the pulse of every session this machine holds, judged from its process and its tool's trace without the
// model (index.ts). It reads session records only: it never binds a session, renews its lease or marks anything read.

import * as HB from './index.ts'
import {agentPorts} from '../ports/index.ts'
import {hubPorts} from '../../hub/ports/index.ts'
import {claim, release} from './singleton.ts'
export {ensurePulse} from './singleton.ts'
import {openHub, openRoom, start} from '../../hub/rooms/index.ts'
import type {Room} from '../../hub/rooms/index.ts'
import {sleep} from '../../../lib/index.ts'
import {allSessions} from '../sessions/index.ts'
import type {Session} from '../sessions/index.ts'

export type Pulse = {session: Session, tool: string, beat: HB.Beat}
// What the room keeps the session waiting for, if anything; a hub that cannot be read says nothing.
const roomWaits = (s: Session): string | null => {
  try {
    const R = openRoom(openHub(s.hub), s.room, {quiet: true})
    return R && R.genesis === s.genesis && !start(R).started ? 'quorum' : null
  } catch { return null }
}
// Two looks `sample` seconds apart when a watcher is among them, so the CPU its turn spent shows.
export const heartbeats = async ({sample = 1}: {sample?: number} = {}): Promise<Pulse[]> => {
  const ss = allSessions()
  const waits = ss.map(roomWaits)
  const first = ss.map((s, i) => HB.probe(s, waits[i], agentPorts().host.snapshot()))
  if (ss.some(s => s.product === 'watch')) await sleep(sample * 1000)
  const rows = agentPorts().host.snapshot()
  return ss.map((s, i) => ({session: s, tool: HB.tracedBy(s), beat: HB.judge(HB.probe(s, waits[i], rows), first[i])}))
}

// One beat of every session here: its hub synced, its pulse judged, its heartbeat put on the last commit of its room
// that this replica pulled. `prev` keeps each session's last facts for the CPU its watcher spent between beats.
export type Beaten = {session: Session, beat?: HB.Beat, error?: string}
export const beatAll = (prev: Map<string, HB.Facts>, next: number): Beaten[] => {
  const rows = agentPorts().host.snapshot()
  return allSessions().flatMap((s): Beaten[] => {
    try {
      const H = openHub(s.hub)
      const R = openRoom(H, s.room, {quiet: true})
      // A gone room: the session leaves it on its own; nothing to beat for.
      if (!R || R.genesis !== s.genesis || !H.store.heartbeat) return []
      const f = HB.probe(s, start(R).started ? null : 'quorum', rows)
      const b = HB.judge(f, prev.get(s.handle) ?? null, {next})
      prev.set(s.handle, f)
      H.store.heartbeat(R.s, s.agent, R.s.tip, HB.body(b))
      return [{session: s, beat: b}]
    } catch (e) { return [{session: s, error: (e as Error).message}] }
  })
}
// Beats until no session is left twice in a row, or the home is gone; `once`: one round.
const beatLoop = async (every: number, once: boolean, log: (s: string) => void): Promise<void> => {
  const prev = new Map<string, HB.Facts>()
  for (let idle = 0; idle < 2;) {
    const beats = beatAll(prev, every)
    for (const b of beats) if (b.error) log(`pulse: ${b.session.agent} in ${b.session.hub}/${b.session.room}: ${b.error}`)
    idle = beats.length ? 0 : idle + 1
    if (once || !hubPorts().state.present()) return
    await sleep(every * 1000)
  }
}
// The loop: one pulse per home, beating every `every` seconds until no session is left or the home is gone.
export const pulse = async ({every = 30, once = false, log}: {every?: number, once?: boolean, log: (s: string) => void}): Promise<number> => {
  const other = claim()
  if (other) { log(`pulse: already running (pid ${other})`); return 0 }
  try { await beatLoop(every, once, log) } finally { release() }
  return 0
}
// What the room's published heartbeats say, as an orchestrator would read them: whose, how old, overdue or not.
export const published = (R: Room) =>
  (R.hub.store.heartbeats?.(R.s) ?? []).map(h => {
    const next = Number(/^Next: (\d+)$/m.exec(h.text)?.[1] ?? NaN)
    const age = Math.max(0, Math.round(Date.now() / 1000 - h.time))
    return {...h, state: /^State: (\w+)$/m.exec(h.text)?.[1] ?? '?', waits: /^Waits: (.+)$/m.exec(h.text)?.[1] ?? null, age, overdue: Number.isFinite(next) && age > next * 2}
  })
