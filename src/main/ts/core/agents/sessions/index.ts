import crypto from 'node:crypto'
import {hubPorts} from '../../hub/ports/index.ts'
import {agentPorts} from '../ports/index.ts'
import {fail} from '../../../lib/index.ts'
export {bound} from './binding.ts'
export type {Bound} from './binding.ts'

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

// The tool this process runs in, by its environment (core/agents/ports/tools.ts).
const detectProduct = (): string | null => agentPorts().tools.find(t => t.detect(process.env))?.id ?? null

// The tool's process among this process's ancestors, by its name.
const ancestry = (): {pid: number, product: string} | null => {
  for (const {pid, name} of agentPorts().host.ancestors(process.ppid)) {
    const tool = agentPorts().tools.find(t => t.processes?.includes(name))
    if (tool) return {pid, product: tool.id}
  }
  return null
}

// A chat is known by a stable handle: RINGI_SESSION, else the session id its tool exposes, else the tool's process as
// a last resort (ps may be denied in a sandbox; then RINGI_SESSION is required).
export const whoAmI = (): Me => {
  const env = process.env
  const product = detectProduct()
  if (env.RINGI_SESSION) return {handle: `env:${env.RINGI_SESSION}`, product, pid: null}
  for (const t of agentPorts().tools) {
    const s = t.session?.(env)
    if (s) return {...s, product: t.id}
  }
  const a = ancestry() ?? fail('cannot tell which session this is: set RINGI_SESSION to a stable id of this chat (for Codex: its thread id) on every ringi command')
  return {handle: `pid:${a.pid}`, product: product ?? a.product, pid: a.pid}
}

// Each session is a record of the machine's state under `sessions`, named after its handle.
const sessionKey = (handle: string) => ['sessions', `${handle.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100)}-${crypto.createHash('sha256').update(handle).digest('hex').slice(0, 10)}`]

export const allSessions = (): Session[] =>
  hubPorts().state.list(['sessions']).map(n => hubPorts().state.read<Session | null>(['sessions', n], null)).filter((s): s is Session => !!s?.handle)

export const readSession = (handle: string): Session | null => {
  const s = hubPorts().state.read<Session | null>(sessionKey(handle), null)
  return s?.handle === handle ? s : null
}

export const saveSession = (s: Session): void => hubPorts().state.write(sessionKey(s.handle), s)

export const dropSession = (handle: string): void => hubPorts().state.remove(sessionKey(handle))

export const pidAlive = (pid: number): boolean => agentPorts().host.alive(pid)

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

export const parseSelector = (sel: string | undefined): {hub: string | null, room: string, agent: string} => {
  const m = /^(?:([a-z0-9._-]+):)?([^/]+)\/([^/]+)$/.exec(sel ?? '')
  return m ? {hub: m[1] ?? null, room: m[2], agent: m[3]} : fail('a session is named <room>/<agent> or <hub>:<room>/<agent>')
}
