// heartbeat: the pulse of every session this machine holds, judged from its process and its tool's trace without the
// model (heartbeat/). It reads session records only: it never binds a session, renews its lease or marks anything read.

import {spawn} from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import * as HB from '../heartbeat/index.ts'
import {alive, table} from '../heartbeat/platform.ts'
import {HOME} from '../home/index.ts'
import {openHub, openRoom, start} from '../hub/index.ts'
import type {Room} from '../hub/index.ts'
import {sleep} from '../lib/index.ts'
import {allSessions} from '../runtime/session.ts'
import type {Session} from '../runtime/session.ts'

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
  const first = ss.map((s, i) => HB.probe(s, waits[i], table()))
  if (ss.some(s => s.product === 'watch')) await sleep(sample * 1000)
  const rows = table()
  return ss.map((s, i) => ({session: s, tool: HB.tracedBy(s), beat: HB.judge(HB.probe(s, waits[i], rows), first[i])}))
}

// --- pulse: the process that beats for every session here, with no model in it ---

const PIDFILE = () => path.join(HOME, 'pulse.pid')
const running = (): number | null => {
  try {
    const pid = Number(fs.readFileSync(PIDFILE(), 'utf8'))
    return pid && pid !== process.pid && alive(pid) ? pid : null
  } catch { return null }
}
// Starts the pulse in the background unless one runs (or RINGI_PULSE=off): join and continue call it.
export const ensurePulse = (cli: string): void => {
  if (process.env.RINGI_PULSE === 'off' || running()) return
  spawn(process.execPath, [cli, 'pulse'], {detached: true, stdio: 'ignore', env: process.env}).unref()
}
// One beat of every session here: its hub synced, its pulse judged, its heartbeat put on the last commit of its room
// that this replica pulled. `prev` keeps each session's last facts for the CPU its watcher spent between beats.
export type Beaten = {session: Session, beat?: HB.Beat, error?: string}
export const beatAll = (prev: Map<string, HB.Facts>, next: number): Beaten[] => {
  const rows = table()
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
// The loop: one pulse per home, beating every `every` seconds until no session is left or the home is gone.
export const pulse = async ({every = 30, once = false, log}: {every?: number, once?: boolean, log: (s: string) => void}): Promise<number> => {
  const other = running()
  if (other) { log(`pulse: already running (pid ${other})`); return 0 }
  fs.writeFileSync(PIDFILE(), String(process.pid))
  const prev = new Map<string, HB.Facts>()
  try {
    for (let idle = 0; idle < 2;) {
      const beats = beatAll(prev, every)
      for (const b of beats) if (b.error) log(`pulse: ${b.session.agent} in ${b.session.hub}/${b.session.room}: ${b.error}`)
      idle = beats.length ? 0 : idle + 1
      if (once || !fs.existsSync(HOME)) break
      await sleep(every * 1000)
    }
  } finally {
    try { if (Number(fs.readFileSync(PIDFILE(), 'utf8')) === process.pid) fs.rmSync(PIDFILE()) } catch {}
  }
  return 0
}
// What the room's published heartbeats say, as an orchestrator would read them: whose, how old, overdue or not.
export const published = (R: Room) =>
  (R.hub.store.heartbeats?.(R.s) ?? []).map(h => {
    const next = Number(/^Next: (\d+)$/m.exec(h.text)?.[1] ?? NaN)
    const age = Math.max(0, Math.round(Date.now() / 1000 - h.time))
    return {...h, state: /^State: (\w+)$/m.exec(h.text)?.[1] ?? '?', waits: /^Waits: (.+)$/m.exec(h.text)?.[1] ?? null, age, overdue: Number.isFinite(next) && age > next * 2}
  })
