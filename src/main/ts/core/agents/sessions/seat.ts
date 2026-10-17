// seat: the name a chat takes in a room, and the session record that holds it. A seat ends only with leave, or the
// operator's takeover (resume.ts).

import {OPERATOR, registeredControlChange} from '../../hub/rooms/index.ts'
import type {RoomV2} from '../../hub/rooms/index.ts'
import {transportOfHub} from '../../hub/usecases/rooms.ts'
import {fail, note, stamp} from '../../../lib/index.ts'
import type {Me, Session} from './index.ts'
import {dropSession, liveness, ownSession, sameRoom, saveSession, seatHolder} from './index.ts'

// A local agent's name: the one this chat holds in the room already; else its tool's, or the first `<tool>-<n>` that is
// no other session's seat and was never removed.
export const seatFor = (me: Me, R: RoomV2): string => {
  const mine = ownSession(me.handle), retired = new Set(Object.keys(R.store.retirements(R.s)))
  if (mine && sameRoom(mine, R) && !retired.has(mine.agent)) return mine.agent
  const base = me.product ?? fail('--as <id> is required: this session\'s product is unknown')
  for (let n = 1; n < 100; n++) {
    const name = n === 1 ? base : `${base}-${n}`
    if (!retired.has(name) && !seatHolder(R, name, me.handle)) return name
  }
  return fail(`no seat is left for ${base} in ${R.endpoint.address}`)
}
// In a local room the root's record adds the member; one removed never returns under that name.
export const ensureMember = (R: RoomV2, agent: string): RoomV2 => {
  if (R.members[agent]) return R
  if (Object.hasOwn(R.store.retirements(R.s), agent)) fail(`${agent} was removed from ${R.endpoint.address}; it joins under another name`)
  return registeredControlChange(R, transportOfHub(R.hub), {who: OPERATOR, subject: `join ${agent}`, mutate: m => {m[agent] = {role: 'member', since: stamp()}}})
}

type JoinContext = {me: Me, R: RoomV2, agent: string, scope?: string}
export const claimSession = (c: JoinContext): void => {
  const {me, R, agent, scope} = c
  const mine = previousSession(c)
  const same = !!mine && sameRoom(mine, R) && mine.agent === agent
  if (R.hub.signed && !R.members[agent]) fail(`${agent} is not in the roster of ${R.endpoint.address}; the root admits its key first`)
  if (mine && !same) note(`left ${mine.room} as ${mine.agent}: one room per session`)
  saveSession({
    handle: me.handle, product: me.product, room: R.endpoint.address, id: R.id, context: R.context, genesis: R.genesis, agent,
    scope: scope ?? (same ? mine!.scope : null), state: 'active', since: same ? mine!.since : stamp(), lastSeen: stamp(), pid: me.pid
  })
}

const previousSession = ({me, R, agent}: JoinContext): Session | null => {
  const holder = seatHolder(R, agent, me.handle)
  if (holder) fail(`${R.endpoint.address}/${agent} is held by another session (${holder.handle}, ${liveness(holder)}). A seat ends only with leave, or the operator's takeover: "continue ${R.endpoint.address}/${agent}" in this chat`)
  const mine = ownSession(me.handle)
  if (mine && mine.handle !== me.handle) dropSession(mine.handle)
  return mine
}
