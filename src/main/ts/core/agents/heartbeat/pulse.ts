// heartbeat: the pulse of every session this machine holds, judged from its process and its tool's trace without the
// model (index.ts). It reads session records only: it never binds a session, renews its lease or marks anything read.

import * as HB from './index.ts'
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
// Every session here, judged now.
export const heartbeats = (): Pulse[] =>
  allSessions().map(s => ({session: s, tool: HB.tracedBy(s), beat: HB.judge(HB.probe(s, roomWaits(s)))}))

// One beat of every session here: its hub synced, its pulse judged, its heartbeat put on the last commit of its room
// that this replica pulled.
export type Beaten = {session: Session, beat?: HB.Beat, error?: string}
const beatAll = (next: number): Beaten[] => allSessions().flatMap((s): Beaten[] => {
  try {
    const H = openHub(s.hub)
    const R = openRoom(H, s.room, {quiet: true})
    // A gone room: the session leaves it on its own; nothing to beat for.
    if (!R || R.genesis !== s.genesis || !H.store.heartbeat) return []
    const b = HB.judge(HB.probe(s, start(R).started ? null : 'quorum'), {next})
    H.store.heartbeat(R.s, s.agent, R.s.tip, HB.body(b))
    return [{session: s, beat: b}]
  } catch (e) { return [{session: s, error: (e as Error).message}] }
})
// Beats until no session is left twice in a row, or the home is gone; `once`: one round.
const beatLoop = async (every: number, once: boolean, log: (s: string) => void): Promise<void> => {
  for (let idle = 0; idle < 2;) {
    const beats = beatAll(every)
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
