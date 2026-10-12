// rooms: the operator's rooms in a hub: list, create, switch, admit and remove members, delete, move to a
// newer contract, and accept a new baseline for a log after reviewing an alarm.

import crypto from 'node:crypto'
import {DEFAULT_PROFILE, parseProfile} from '../work/index.ts'
import {hubPorts, locked} from '../ports/index.ts'
import {OPERATOR, RESERVED_ROOMS, ROOM_MD, config, controlChange, profileText, room as roomOf, roomNames, setConfig} from '../rooms/index.ts'
import type {Hub, Room} from '../rooms/index.ts'
import {Fail, fail, note} from '../../../lib/index.ts'
import {ID_RE, compose} from '../protocol/index.ts'
import {notSigned} from './roster.ts'

export {admit, forgetLog, remove} from './roster.ts'

// The operator's terminal context picks the room unless one is named.
export const roomIn = (H: Hub, name?: string | null): Room => roomOf(H, name ?? config().room)
// A room the store offers but that does not open (a history under another name) is an alarm, not a row.
const opens = (H: Hub, n: string): Room | null => {
  try { return roomOf(H, n) } catch (e) {
    if (!(e instanceof Fail)) throw e
    note(`ALARM ${e.message}`)
    return null
  }
}
export type RoomView = {name: string, current: boolean, members: number, profile: string, genesis: string}
export const rooms = (H: Hub): RoomView[] => {
  const cur = config().room
  const view = (n: string, R: Room): RoomView => ({name: n, current: n === cur, members: Object.keys(R.members).length, profile: R.profile.name, genesis: R.genesis})
  return roomNames(H).flatMap(n => { const R = opens(H, n); return R ? [view(n, R)] : [] })
}
// A room carries its profile from the start: later changes to the hub's profiles do not reach it.
// `quorum`: the room's work starts by itself once it has that many agents; until then a join waits.
export const create = (H: Hub, name: string, {profile, quorum}: {profile?: string, quorum?: number} = {}): {profile: string} => {
  if (!ID_RE.test(name) || RESERVED_ROOMS.has(name)) fail(`usage: ringi room create <id> [--profile <name>] [--quorum <agents>] (an id like fix-badge; not ${[...RESERVED_ROOMS].join(', ')})`)
  if (quorum !== undefined && !(Number.isSafeInteger(quorum) && quorum >= 1 && quorum <= 99)) fail('--quorum takes a number of agents, 1 to 99')
  const p = profile ?? H.contract.profile ?? DEFAULT_PROFILE
  const text = profileText(H, p) ?? fail(`hub ${H.name} carries no profile ${p}; add it with ringi hub amend -m "<why>" --attach <file>:profiles/${p}.json`)
  parseProfile(text, `profile ${p}`)
  locked(`hub-${H.name}`, () => {
    const files: Record<string, string> = {'ROOM.md': ROOM_MD(name), 'members.json': JSON.stringify({[OPERATOR]: {role: 'root'}}, null, 2) + '\n', 'profile.json': text}
    // A signed room's roster: who may sign its logs, starting with the root.
    if (H.signed) files.allowed_signers = H.store.rootRoster?.() ?? fail(`hub ${H.name}: its store cannot start a signed roster`)
    // The genesis names the room; a random id makes it unique, so a room deleted and created again is a different room.
    H.store.createRoom(name, OPERATOR, compose(`room ${name}`, [['To', '*'], ['Kind', 'room'], ['Room-Id', crypto.randomBytes(16).toString('hex')],
      ...(quorum ? [['Quorum', String(quorum)] as [string, string]] : [])]), files)
  })
  setConfig({hub: H.name, room: name})
  return {profile: p}
}
export const use = (H: Hub, name: string): Room => {
  const R = roomOf(H, name)
  setConfig({hub: H.name, room: R.name})
  return R
}
// The room and everything kept for it: in the store (deleteRoom) and its readers' state. The sessions bound to it,
// on this machine or another, leave it on their own when they find its branch gone (core/agents/sessions).
export const erase = (H: Hub, R: Room): void => {
  notSigned(H, 'delete')
  locked(`hub-${H.name}`, () => H.store.deleteRoom(R.s))
  hubPorts().state.remove(['readers', H.name, R.genesis])
  if (config().room === R.name) setConfig({room: null})
}
// The room follows the hub's current contract from now on; nothing written before is reinterpreted.
export const rebase = (H: Hub, R: Room): void => controlChange(R, OPERATOR, `contract ${H.contract.version}`, () => {}, [['Contract', H.main]])
