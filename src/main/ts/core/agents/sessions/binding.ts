import {locked} from '../../hub/ports/index.ts'
import type {Hub, Room} from '../../hub/rooms/index.ts'
import {openHub, openRoom, roomNames} from '../../hub/rooms/index.ts'
import {fail, stamp} from '../../../lib/index.ts'
import type {Me, Session} from './index.ts'
import {dropSession, readSession, saveSession, whoAmI} from './index.ts'

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
  checkRoomIdentity(me, s, H, R)
  if (!R!.members[s.agent]) fail(`${s.agent} was removed from room ${s.room}; returning needs a fresh join by the operator`)
  renewSession(me, s)
  return {s, H, R: R!, me: s.agent}
}

const checkRoomIdentity = (me: Me, s: Session, H: Hub, R: Room | null): void => {
  if (!R || R.genesis !== s.genesis) {
    // The room's branch is gone (deleted, archived, or deleted and made anew): the session leaves it on its own. A hub
    // that cannot be reached fails above and leaves nothing.
    locked('sessions', () => {if (readSession(me.handle)?.genesis === s.genesis) dropSession(me.handle)})
    const gone = roomNames(H, true).find(a => a === `${s.room}@${s.genesis.slice(0, 8)}`)
    fail(gone ? `room ${s.room} was archived as ${gone}; this session left it`
      : R ? `room ${s.room} was deleted and created again; this session left the old room. The operator joins it anew`
        : `room ${s.room} is gone from hub ${s.hub}; this session left it`)
  }
}

const renewSession = (me: Me, s: Session): void => {
  locked('sessions', () => {
    const cur = readSession(me.handle) ?? fail('this session lost its seat')
    if (cur.state !== 'active' || cur.genesis !== s.genesis || cur.agent !== s.agent) fail('this session was stopped or its seat changed')
    saveSession({...cur, lastSeen: stamp(), pid: me.pid ?? cur.pid})
  })
}
