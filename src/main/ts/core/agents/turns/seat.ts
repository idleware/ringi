import {locked} from '../../hub/ports/index.ts'
import {config, openHub, openRoom} from '../../hub/rooms/index.ts'
import {fail, stamp} from '../../../lib/index.ts'
import type {Session} from '../sessions/index.ts'
import {dropSession, liveness, parseSelector, pidAlive, saveSession, seatHolder, whoAmI} from '../sessions/index.ts'
import {validateWatch} from './limits.ts'
import type {WatchContext, WatchOptions} from './types.ts'

const handoff = (c: WatchContext, holder: Session | undefined): boolean => {
  const own = c.w.handoff && holder?.product !== 'watch' && holder?.handle === whoAmI().handle
  if (c.w.handoff && !own) fail('watch --handoff needs the invoking chat to own this seat')
  if (own && holder!.state === 'stopped') fail('this chat is stopped; continue it before a handoff')
  const live = holder && (holder.product !== 'watch' || (holder.pid && pidAlive(holder.pid)))
  if (holder && !own && live) fail(`${c.R0.name}/${c.me} is held by session ${holder.handle} (${liveness(holder)}); one seat per agent. Its chat may use watch --handoff`)
  return !!own
}
const claim = (c: WatchContext): void => locked('sessions', () => {
  const {w, H0, R0, me, handle} = c
  const holder = seatHolder(H0.name, R0.genesis, me, handle), handed = handoff(c, holder)
  if (holder) dropSession(holder.handle)
  saveSession({
    handle, product: 'watch', hub: H0.name, room: R0.name, genesis: R0.genesis, agent: me, scope: w.scope ?? holder?.scope ?? null,
    state: holder?.state === 'stopped' ? 'stopped' : 'active', since: stamp(), lastSeen: stamp(), pid: process.pid,
    takenFrom: handed ? holder!.handle : holder?.takenFrom
  })
})
export const createWatcher = (w: WatchOptions, log: (line: string) => void): WatchContext => {
  validateWatch(w)
  const sel = parseSelector(w.seat), H0 = openHub(sel.hub ?? w.hub ?? config().hub), R0 = openRoom(H0, sel.room)!, me = sel.agent
  if (R0.archived) fail(`${R0.name} is archived`)
  if (!R0.members[me]) fail(`${me} is not a member of ${R0.name}; the operator adds it with a join, or watch another agent`)
  const raw = `watch-${H0.name}-${R0.genesis.slice(0, 8)}-${me}-${process.pid}`, handle = `env:${raw}`
  const c: WatchContext = {
    w, H0, R0, me, raw, handle, cmd: w.exec, log, interval: (w.interval ?? 5) * 1000,
    allow: w.from ? new Set(w.from) : null, maxHop: w.maxHop ?? 8, maxRuns: w.maxRuns ?? 10, span: w.window ?? 86400, runSeq: 0
  }
  claim(c)
  return c
}
