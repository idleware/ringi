// join: a chat takes a seat in a room as an agent, one room per chat; on a signed hub its key must be admitted first.

import {locked} from '../../hub/ports/index.ts'
import type {Hub, Room} from '../../hub/rooms/index.ts'
import {OPERATOR, attachRoom, adoptHub, controlChange} from '../../hub/rooms/index.ts'
import {roomNamed} from '../../hub/usecases/rooms.ts'
import {readInvite} from '../../hub/usecases/invite.ts'
import {fail, note, stamp} from '../../../lib/index.ts'
import {agentId} from '../../hub/usecases/roster.ts'
import type {Me, Session} from './index.ts'
import {dropSession, liveness, ownSession, readSession, saveSession, seatHolder, whoAmI} from './index.ts'
import type {JoinKey} from '../../hub/ports/store.ts'

// `room`: a room's name on this machine, or the operator's invitation to one elsewhere; an agent never names a hub.
export type JoinInput = {room: string, agent?: string, scope?: string}

export type JoinResult = {agent: string, hub: string, room: string} & ({session: Session, key: null} | {session: null, key: JoinKey})

// The room an invitation names, attached on first use; or the one room of that name on this machine.
const roomFor = (target: string): Room => {
  const x = readInvite(target)
  if (x) return attachRoom(adoptHub({trust: x.trust, root: x.root, genesis: x.hubGenesis}), x.room,
    {schema: 'ringi-room/1', name: x.room, hubGenesis: x.hubGenesis, genesis: x.genesis, store: {path: 'store', remote: x.address}})
  return roomNamed(target)
}
export const join = ({room: target, agent: id, scope}: JoinInput): JoinResult => {
  const me = whoAmI()
  const agent = id ?? me.product ?? fail('--as <id> is required: this session\'s product is unknown')
  agentId(agent)
  const R = roomFor(target), H = R.hub, room = R.name
  if (H.signed) {
    if (!R.store.joinKey) fail(`hub ${H.name}: its store cannot make keys`)
    const key = R.store.joinKey!(R.s, agent)
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
  if (mine && !same) note(`left ${mine.room} as ${mine.agent}: one room per session`)
  saveSession({
    handle: me.handle, product: me.product, hub: H.name, room: R.name, genesis: R.genesis, agent,
    scope: scope ?? (same ? mine!.scope : null), state: 'active', since: same ? mine!.since : stamp(), lastSeen: stamp(), pid: me.pid
  })
}

const previousSession = ({me, H, R, agent, room}: JoinContext): Session | null => {
  const holder = seatHolder(H.name, R.genesis, agent, me.handle)
  if (holder) fail(`${room}/${agent} is held by another session (${holder.handle}, ${liveness(holder)}). A seat ends only with leave, or the operator's takeover: "continue ${room}/${agent}" in this chat`)
  const mine = ownSession(me.handle)
  if (mine && mine.handle !== me.handle) dropSession(mine.handle)
  return mine
}

const ensureMember = ({H, R, agent, room}: JoinContext): void => {
  if (!R.members[agent]) {
    if (H.signed) fail(`${agent} is not in the roster of ${room}; the root admits its key first`)
    controlChange(R, OPERATOR, `join ${agent}`, m => {m[agent] = {role: 'member', since: stamp()}})
  }
}
