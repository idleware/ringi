// join: a chat takes a seat in a room as an agent, one room per chat. A local room is joined by its name, as the tool
// the chat runs in; a room in a space by the invitation the root made for one account, as the actor it names, once
// the root admitted the key this machine shows (invitation.ts).

import {locked} from '../../hub/ports/index.ts'
import type {RoomV2} from '../../hub/rooms/index.ts'
import {registeredRoomLock} from '../../hub/rooms/index.ts'
import {roomNamed} from '../../hub/usecases/rooms.ts'
import {readInvite} from '../../hub/usecases/invite.ts'
import type {InviteV3} from '../../hub/usecases/invite.ts'
import {fail} from '../../../lib/index.ts'
import {agentId} from '../../hub/usecases/roster.ts'
import type {Me, Session} from './index.ts'
import {readSession, whoAmI} from './index.ts'
import {attached, joinedActor, pendingOf} from './invitation.ts'
import type {Pending} from './invitation.ts'
import {claimSession, ensureMember, seatFor} from './seat.ts'

// `room`: a room's address or name on this machine, or the operator's invitation to one in a space. `agent`: the
// chat's own name where ringi cannot tell its tool; in a space the invitation names it. `identity`: a key file of the
// operator's to sign and reach a space with, instead of one ringi makes.
export type JoinInput = {room: string, agent?: string, scope?: string, identity?: string}
export type {Pending} from './invitation.ts'
export type JoinResult = {agent: string, room: string} & ({session: Session, pending: null} | {session: null, pending: Pending})

const NO_AS = 'in a space the invitation names the actor: join without --as'
const seated = (me: Me, R: RoomV2, agent: string): JoinResult => ({agent, room: R.endpoint.address, session: readSession(me.handle)!, pending: null})
// In a space: the actor the invitation named, once its key is in the room's roster.
const joinSigned = (me: Me, R: RoomV2, x: InviteV3 | null, scope?: string): JoinResult => {
  const agent = agentId(x?.actor ?? joinedActor(R))
  const key = R.store.joinKey?.(R.s, agent) ?? fail(`room ${R.endpoint.address}: its store cannot make keys`)
  if (!key.admitted) return {agent, room: R.endpoint.address, session: null, pending: pendingOf(x, key)}
  locked('sessions', () => claimSession({me, R, agent, scope}))
  return seated(me, R, agent)
}
// In a local room: the chat's own name, or its tool's, its seat claimed and its membership recorded together.
const joinLocal = (me: Me, R: RoomV2, asked?: string, scope?: string): JoinResult => seated(me, R, locked(`${registeredRoomLock(R)}-seats`, () => {
  const name = agentId(asked ?? seatFor(me, R))
  locked('sessions', () => claimSession({me, R: ensureMember(R, name), agent: name, scope}))
  return name
}))
export const join = ({room: target, agent: asked, scope, identity}: JoinInput): JoinResult => {
  const me = whoAmI(), x = readInvite(target)
  if (x && asked) fail(NO_AS)
  const found = x ? attached(x, identity) : roomNamed(target)
  if ('key' in found) return {agent: x!.actor, room: x!.address, session: null, pending: found}
  if (found.hub.signed && asked) fail(NO_AS)
  return found.hub.signed ? joinSigned(me, found, x, scope) : joinLocal(me, found, asked, scope)
}
