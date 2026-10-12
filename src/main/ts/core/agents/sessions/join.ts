import {locked} from '../../hub/ports/index.ts'
import type {Hub, Room} from '../../hub/rooms/index.ts'
import {OPERATOR, controlChange, openHub, room as roomOf} from '../../hub/rooms/index.ts'
import {fail, note, stamp} from '../../../lib/index.ts'
import {AGENT_RE} from '../../hub/protocol/index.ts'
import type {Me, Session} from './index.ts'
import {dropSession, liveness, ownSession, pidAlive, readSession, saveSession, seatHolder, whoAmI} from './index.ts'
import type {JoinKey} from '../../hub/ports/store.ts'

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
  locked('sessions', () => claimSession({me, H, R, agent, room, scope}))
  return {agent, hub: H.name, room: R.name, session: readSession(me.handle)!, key: null}
}

type JoinContext = {me: Me, H: Hub, R: Room, agent: string, room: string, scope?: string}
const claimSession = (c: JoinContext): void => {
  const {me, H, R, agent, scope} = c
  const mine = previousSession(c)
  const same = !!mine && mine.hub === H.name && mine.genesis === R.genesis && mine.agent === agent
  ensureMember(c)
  if (mine && !same) note(`left ${mine.hub}/${mine.room} as ${mine.agent}: one room per session`)
  saveSession({
    handle: me.handle, product: me.product, hub: H.name, room: R.name, genesis: R.genesis, agent,
    scope: scope ?? (same ? mine!.scope : null), state: 'active', since: same ? mine!.since : stamp(), lastSeen: stamp(), pid: me.pid
  })
}

const previousSession = ({me, H, R, agent, room}: JoinContext): Session | null => {
  const holder = seatHolder(H.name, R.genesis, agent, me.handle)
  if (holder) fail(`${room}/${agent} is held by another session (${holder.handle}, ${liveness(holder)}). A seat ends only with leave, or the operator's takeover: "continue ${room}/${agent}" in this chat`)
  const mine = ownSession(me.handle)
  if (mine?.product === 'watch' && mine.pid && pidAlive(mine.pid)) fail('this chat handed its seat to a live watcher; stop or leave it before joining another room')
  if (mine && mine.handle !== me.handle) dropSession(mine.handle)
  return mine
}

const ensureMember = ({H, R, agent, room}: JoinContext): void => {
  if (!R.members[agent]) {
    if (H.signed) fail(`${agent} is not in the roster of ${room}; the root admits its key first`)
    controlChange(R, OPERATOR, `join ${agent}`, m => {m[agent] = {role: 'member', since: stamp()}})
  }
}
