// binding: the seat a chat holds, checked on every agent command: joined, not stopped, its room alive and the same
// room, still a member; a chat whose room is gone leaves it on its own.

import {hubPorts, locked} from '../../hub/ports/index.ts'
import type {Hub, RoomV2} from '../../hub/rooms/index.ts'
import {roomCatalogue, registrationContext} from '../../hub/rooms/room-catalogue.ts'
import {roomNamed} from '../../hub/usecases/rooms.ts'
import {fail, stamp} from '../../../lib/index.ts'
import type {Me, Session} from './index.ts'
import {dropSession, readSession, sameRoom, saveSession, whoAmI} from './index.ts'

export type Bound = {s: Session, H: Hub, R: RoomV2, me: string}

// The binding, checked on every agent command: joined, not stopped, room alive and the same room, still a member.
export const bound = (): Bound => {
  const me = whoAmI()
  const s = readSession(me.handle) ?? fail(`this session is not in a room. Take part only when the operator says so in this chat:
  "join <room>" runs ringi join <room> --scope "<what they delegate>" (<room>: its address or name, or the invitation);
  after a restart, "continue" runs ringi continue.`)
  if (s.state === 'stopped') fail('this session is stopped: the operator paused it. It reacts to nothing until the operator says "continue" (ringi continue)')
  const R = roomOf(me, s)
  if (!R.members[s.agent]) fail(`${s.agent} was removed from room ${s.room}; returning needs a fresh join by the operator`)
  renewSession(me, s)
  return {s, H: R.hub, R, me: s.agent}
}

// The room the seat belongs to, as this machine registered it. A room deleted, or deleted and made anew at its
// address, is another room: the session leaves the old one. A room that cannot be reached fails and leaves nothing.
const roomOf = (me: Me, s: Session): RoomV2 => {
  const r = roomCatalogue(hubPorts().state).get(s.id)
  const alive = r?.phase === 'active' && !r.endpoint.disposal && sameRoom(s, {context: registrationContext(r)})
  const R = alive ? roomNamed(r.address) : null
  if (R && sameRoom(s, R)) return R
  locked('sessions', () => {if (readSession(me.handle)?.id === s.id) dropSession(me.handle)})
  return fail(r?.phase === 'active' && !r.endpoint.disposal ? `room ${s.room} was deleted and created again; this session left the old room. The operator joins it anew`
    : `room ${s.room} is gone from this machine; this session left it`)
}

const renewSession = (me: Me, s: Session): void => {
  locked('sessions', () => {
    const cur = readSession(me.handle) ?? fail('this session lost its seat')
    if (cur.state !== 'active' || !sameRoom(cur, s) || cur.agent !== s.agent) fail('this session was stopped or its seat changed')
    saveSession({...cur, lastSeen: stamp(), pid: me.pid ?? cur.pid})
  })
}
