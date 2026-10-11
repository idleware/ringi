// session: which chat is which, and which seat it holds. A seat is one (hub, room genesis, agent); it ends only with
// leave or the operator's explicit takeover. Every agent command passes `bound()` first.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {HOME, guard, locked, readJson, writeJson} from '../home/index.ts'
import {openHub, openRoom, roomNames} from '../hub/index.ts'
import type {Hub, Room} from '../hub/index.ts'
import {errno, fail, stamp} from '../lib/index.ts'

export const LEASE = 60 * 60 * 1000

export type Session = {
  handle: string
  product: string | null
  hub: string
  room: string
  genesis: string
  agent: string
  scope: string | null
  state: 'active' | 'stopped'
  since: string
  lastSeen: string
  pid: number | null
  takenFrom?: string
}
export type Me = {handle: string, product: string | null, pid: number | null}

const detectProduct = (): string | null => {
  const env = process.env
  if (env.CLAUDECODE === '1' || env.CLAUDE_CODE_SESSION_ID) return 'claude'
  if (Object.keys(env).some(k => k.startsWith('CODEX_'))) return 'codex'
  if (Object.keys(env).some(k => k.startsWith('CURSOR_'))) return 'cursor'
  return null
}
const ancestry = (): {pid: number, product: string} | null => {
  let pid = process.ppid
  for (let i = 0; i < 12 && pid > 1; i++) {
    const r = spawnSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], {encoding: 'utf8'})
    const m = r.status === 0 ? /^\s*(\d+)\s+(.*)$/.exec(String(r.stdout ?? '').trim()) : null
    if (!m) return null
    const comm = path.basename(m[2].trim()).toLowerCase()
    if (/^(claude|codex|cursor|cursor-agent)$/.test(comm)) return {pid, product: comm.replace('-agent', '')}
    pid = Number(m[1])
  }
  return null
}
// A chat is known by a stable handle: RINGI_SESSION, else the chat id the UI exposes, else the UI process as a last
// resort (ps may be denied in a sandbox; then RINGI_SESSION is required).
export const whoAmI = (): Me => {
  const env = process.env
  const product = detectProduct()
  if (env.RINGI_SESSION) return {handle: `env:${env.RINGI_SESSION}`, product, pid: null}
  if (env.CLAUDE_CODE_SESSION_ID) return {handle: `claude:${env.CLAUDE_CODE_SESSION_ID}`, product: 'claude', pid: Number(env.CLAUDE_PID) || null}
  const a = ancestry() ?? fail('cannot tell which session this is: set RINGI_SESSION to a stable id of this chat (for Codex: its thread id) on every ringi command')
  return {handle: `pid:${a.pid}`, product: product ?? a.product, pid: a.pid}
}
const sessionsDir = () => path.join(HOME, 'sessions')
const sessionFile = (handle: string) => path.join(sessionsDir(), `${handle.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100)}-${crypto.createHash('sha256').update(handle).digest('hex').slice(0, 10)}.json`)
export const allSessions = (): Session[] => {
  let files: string[] = []
  try { files = fs.readdirSync(sessionsDir()).filter(f => f.endsWith('.json')) } catch {}
  return files.map(f => readJson<Session | null>(path.join(sessionsDir(), f), null)).filter((s): s is Session => !!s?.handle)
}
export const readSession = (handle: string): Session | null => {
  const s = readJson<Session | null>(sessionFile(handle), null)
  return s?.handle === handle ? s : null
}
export const saveSession = (s: Session): void => writeJson(sessionFile(s.handle), s)
export const dropSession = (handle: string): void => { guard(() => fs.rmSync(sessionFile(handle), {force: true})) }
export const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) { return errno(e) === 'EPERM' }
}
// active: in use within the lease by a living process; stopped: paused by the operator; gone: neither. A gone or
// stopped binding keeps its seat and scope. A watcher is alive exactly while its process is: a run may outlast any
// lease.
export const liveness = (s: Session): 'active' | 'stopped' | 'gone' => s.state === 'stopped' ? 'stopped'
  : s.product === 'watch' ? (s.pid && pidAlive(s.pid) ? 'active' : 'gone')
    : Date.now() - Date.parse(s.lastSeen) < LEASE && (!s.pid || pidAlive(s.pid)) ? 'active' : 'gone'
export const seatHolder = (hub: string, genesis: string, agent: string, except: string): Session | undefined =>
  allSessions().find(s => s.hub === hub && s.genesis === genesis && s.agent === agent && s.handle !== except)
// An explicit chat-to-watch handoff remembers only that chat; it never selects another chat's seat.
export const ownSession = (handle: string): Session | null => readSession(handle)
  ?? allSessions().find(s => s.product === 'watch' && s.takenFrom === handle) ?? null
export type Bound = {s: Session, H: Hub, R: Room, me: string}
// The binding, checked on every agent command: joined, not stopped, room alive and the same room, still a member.
export const bound = (): Bound => {
  const me = whoAmI()
  const s = readSession(me.handle) ?? fail(`this session is not in a room. Take part only when the operator says so in this chat:
  "join <room> as <id>" runs ringi join local <room> --as <id> --scope "<what they delegate>";
  after a restart, "continue" runs ringi continue.`)
  if (s.state === 'stopped') fail('this session is stopped: the operator paused it. It reacts to nothing until the operator says "continue" (ringi continue)')
  const H = openHub(s.hub)
  const R = openRoom(H, s.room, {quiet: true})
  if (!R || R.genesis !== s.genesis) {
    // The room's branch is gone (deleted, archived, or deleted and made anew): the session leaves it on its own. A hub
    // that cannot be reached fails above and leaves nothing.
    locked('sessions', () => { if (readSession(me.handle)?.genesis === s.genesis) dropSession(me.handle) })
    const gone = roomNames(H, true).find(a => a === `${s.room}@${s.genesis.slice(0, 8)}`)
    fail(gone ? `room ${s.room} was archived as ${gone}; this session left it`
      : R ? `room ${s.room} was deleted and created again; this session left the old room. The operator joins it anew`
        : `room ${s.room} is gone from hub ${s.hub}; this session left it`)
  }
  if (!R!.members[s.agent]) fail(`${s.agent} was removed from room ${s.room}; returning needs a fresh join by the operator`)
  locked('sessions', () => {
    const cur = readSession(me.handle) ?? fail('this session lost its seat')
    if (cur.state !== 'active' || cur.genesis !== s.genesis || cur.agent !== s.agent) fail('this session was stopped or its seat changed')
    saveSession({...cur, lastSeen: stamp(), pid: me.pid ?? cur.pid})
  })
  return {s, H, R: R!, me: s.agent}
}
export const parseSelector = (sel: string | undefined): {hub: string | null, room: string, agent: string} => {
  const m = /^(?:([a-z0-9._-]+):)?([^/]+)\/([^/]+)$/.exec(sel ?? '')
  return m ? {hub: m[1] ?? null, room: m[2], agent: m[3]} : fail('a session is named <room>/<agent> or <hub>:<room>/<agent>')
}
