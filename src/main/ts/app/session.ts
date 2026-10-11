// Session use cases preserve the operator's identity, seat and delegated scope.
import {OPERATOR, ensureHome, locked} from '../home/index.ts'
import {controlChange, openHub, room as roomOf} from '../hub/index.ts'
import {AGENT_RE} from '../protocol/index.ts'
import {allSessions, bound, dropSession, liveness, ownSession, parseSelector, pidAlive, readSession, saveSession, seatHolder, whoAmI} from '../runtime/session.ts'
import type {Session} from '../runtime/session.ts'
import type {JoinKey} from '../store/index.ts'
import {fail, note, stamp} from '../lib/index.ts'
import {inbox} from './agent.ts'
import {tasks} from './room.ts'

export {bound} from '../runtime/session.ts'
export type {Session} from '../runtime/session.ts'
export const briefing = (s: Session) => {
  const actor = bound()
  return {session: s, actor, tasks: tasks(actor).views, inbox: inbox(actor)}
}
export type JoinInput = {hub: string, room: string, agent?: string, scope?: string}
export type JoinResult = {agent: string, hub: string, room: string} & ({session: Session, key: null} | {session: null, key: JoinKey})
export const join = ({hub, room, agent: id, scope}: JoinInput): JoinResult => {
  const me = whoAmI()
  const agent = id ?? me.product ?? fail('--as <id> is required: this session\'s product is unknown')
  if (!AGENT_RE.test(agent) || agent === OPERATOR) fail(`bad agent id ${agent}: lowercase letters, digits, - and _, no dot`)
  const H = openHub(hub), R = roomOf(H, room)
  if (R.archived) fail(`${room} is archived`)
  if (H.signed) {
    if (!H.store.joinKey) fail(`hub ${H.name}: its store cannot make keys`)
    const key = H.store.joinKey!(R.s, agent)
    if (!key.admitted) return {agent, hub: H.name, room: R.name, session: null, key}
  }
  locked('sessions', () => {
    const holder = seatHolder(H.name, R.genesis, agent, me.handle)
    if (holder) fail(`${room}/${agent} is held by another session (${holder.handle}, ${liveness(holder)}). A seat ends only with leave, or the operator's takeover: "continue ${room}/${agent}" in this chat`)
    const mine = ownSession(me.handle)
    if (mine?.product === 'watch' && mine.pid && pidAlive(mine.pid)) fail('this chat handed its seat to a live watcher; stop or leave it before joining another room')
    if (mine && mine.handle !== me.handle) dropSession(mine.handle)
    const same = !!mine && mine.hub === H.name && mine.genesis === R.genesis && mine.agent === agent
    if (!R.members[agent]) {
      if (H.signed) fail(`${agent} is not in the roster of ${room}; the root admits its key first`)
      controlChange(R, OPERATOR, `join ${agent}`, m => { m[agent] = {role: 'member', since: stamp()} })
    }
    if (mine && !same) note(`left ${mine.hub}/${mine.room} as ${mine.agent}: one room per session`)
    saveSession({handle: me.handle, product: me.product, hub: H.name, room: R.name, genesis: R.genesis, agent,
      scope: scope ?? (same ? mine!.scope : null), state: 'active', since: same ? mine!.since : stamp(), lastSeen: stamp(), pid: me.pid})
  })
  return {agent, hub: H.name, room: R.name, session: readSession(me.handle)!, key: null}
}
export const resume = (selector?: string): Session => {
  const me = whoAmI()
  ensureHome()
  return locked('sessions', () => {
    let target: Session
    if (!selector) {
      const mine = ownSession(me.handle)
      if (!mine) {
        const cands = allSessions().filter(s => liveness(s) !== 'active').sort((a, b) => Number(b.product === me.product) - Number(a.product === me.product))
        if (!cands.length) fail('nothing to continue: this chat was never joined, and no paused or gone session waits. The operator says "join <room> as <id>"')
        fail(`this chat has no binding of its own. Say which one to take over:\n${cands.map(s => `  ringi continue ${s.hub}:${s.room}/${s.agent}   (${liveness(s)}, ${s.product ?? '?'}, ${s.handle}${s.scope ? `, scope: ${s.scope}` : ''})`).join('\n')}`)
      }
      target = mine!
    } else {
      const sel = parseSelector(selector)
      const hits = allSessions().filter(s => s.room === sel.room && s.agent === sel.agent && (!sel.hub || s.hub === sel.hub))
      if (hits.length > 1) fail(`several hubs have ${sel.room}/${sel.agent}; name one: <hub>:${sel.room}/${sel.agent}`)
      target = hits[0] ?? fail(`no session holds ${selector}; the operator joins this chat with ringi join`)
    }
    if (target.handle !== me.handle) {
      if (liveness(target) === 'active' || (target.product === 'watch' && target.pid && pidAlive(target.pid))) fail(`${target.room}/${target.agent} is held by a live session (${target.handle}); it is not taken over`)
      dropSession(target.handle)
      note(`took over ${target.hub}/${target.room}/${target.agent} from ${target.handle}`)
    }
    const session: Session = {...target, handle: me.handle, product: target.handle === me.handle ? target.product : me.product, state: 'active',
      since: target.handle === me.handle ? target.since : stamp(), lastSeen: stamp(), pid: me.pid ?? (target.handle === me.handle ? target.pid : null),
      takenFrom: target.handle === me.handle ? target.takenFrom : undefined}
    saveSession(session)
    return session
  })
}
export const stop = (): Session => locked('sessions', () => {
  const s = ownSession(whoAmI().handle) ?? fail('this session is in no room')
  const stopped: Session = {...s, state: 'stopped', lastSeen: stamp()}
  saveSession(stopped)
  return stopped
})
export const leave = (): Session => locked('sessions', () => {
  const s = ownSession(whoAmI().handle) ?? fail('this session is in no room')
  dropSession(s.handle)
  return s
})
