// rooms: the rooms on this machine, each named uniquely whatever hub keeps it: list, create, switch, admit a member,
// delete, and accept a new baseline for a log after reviewing an alarm.

import crypto from 'node:crypto'
import {DEFAULT_PROFILE, parseProfile} from '../work/index.ts'
import {hubPorts} from '../ports/index.ts'
import {OPERATOR, RESERVED_ROOMS, ROOM_MD, config, createRoom, deleteRoom, hubNames, openContract, openHub, profileText, room as roomOf, roomNames, setConfig} from '../rooms/index.ts'
import type {Hub, Room} from '../rooms/index.ts'
import {Fail, fail, note} from '../../../lib/index.ts'
import {invite} from './invite.ts'
import {overSsh, roomAddress} from './access.ts'
import {ID_RE, compose} from '../protocol/index.ts'

export {admit, forgetLog} from './roster.ts'

// A room by its name, unique on this machine whatever hub keeps it; without one, the terminal's current room.
export const roomNamed = (name?: string | null): Room => {
  hubPorts().state.ensure()
  const n = name ?? config().room ?? fail('no current room: ringi room create <id> | ringi room switch <id>')
  const hub = hubNames().find(h => roomNames(openHub(h)).includes(n)) ?? fail(`no room ${n} on this machine`)
  return roomOf(openHub(hub), n)
}
// A room the store offers but that does not open (a history under another name) is an alarm, not a row.
const opens = (H: Hub, n: string): Room | null => {
  try { return roomOf(H, n) } catch (e) {
    if (!(e instanceof Fail)) throw e
    note(`ALARM ${e.message}`)
    return null
  }
}
export type RoomView = {name: string, hub: string, current: boolean, members: number, profile: string, genesis: string}
export const rooms = (): RoomView[] => {
  hubPorts().state.ensure()
  const cur = config().room
  const view = (H: Hub, n: string, R: Room): RoomView => ({name: n, hub: H.name, current: n === cur, members: Object.keys(R.members).length, profile: R.profile.name, genesis: R.genesis})
  return hubNames().map(h => openHub(h)).flatMap(H => roomNames(H).flatMap(n => { const R = opens(H, n); return R ? [view(H, n, R)] : [] }))
}
// A room carries its profile from the start: later changes to the hub's profiles do not reach it.
// `quorum`: the room's work starts by itself once it has that many agents; until then a join waits.
// `url`: a signed hub publishes the room's repository there; on a hub whose rooms a forge keeps, the forge makes it.
// The result says how an agent elsewhere joins it.
export const create = async (H: Hub, name: string, {profile, quorum, url}: {profile?: string, quorum?: number, url?: string} = {}): Promise<{profile: string, join: string | null}> => {
  if (!ID_RE.test(name) || RESERVED_ROOMS.has(name)) fail(`usage: ringi room create <id> [--profile <name>] [--quorum <agents>] (an id like fix-badge; not ${[...RESERVED_ROOMS].join(', ')})`)
  if (quorum !== undefined && !(Number.isSafeInteger(quorum) && quorum >= 1 && quorum <= 99)) fail('--quorum takes a number of agents, 1 to 99')
  const contract = openContract(H)
  const p = profile ?? contract.contract.profile ?? DEFAULT_PROFILE
  const text = profileText(H, p) ?? fail(`hub ${H.name} carries no profile ${p}; add it with ringi hub amend -m "<why>" --attach <file>:profiles/${p}.json`)
  parseProfile(text, `profile ${p}`)
  const files: Record<string, string> = {'ROOM.md': ROOM_MD(name), 'members.json': JSON.stringify({[OPERATOR]: {role: 'root'}}, null, 2) + '\n', 'profile.json': text}
  // A signed room's roster: who may sign its logs, starting with the root.
  if (H.signed) files.allowed_signers = contract.store.rootRoster?.() ?? fail(`hub ${H.name}: its store cannot start a signed roster`)
  // The genesis names the room; a random id makes it unique, so a room deleted and created again is a different room.
  const genesis = compose(`room ${name}`, [['To', '*'], ['Kind', 'room'], ['Room-Id', crypto.randomBytes(16).toString('hex')],
    ...(quorum ? [['Quorum', String(quorum)] as [string, string]] : [])])
  const remote = await roomAddress(H, name, url)
  // Over SSH the root's own key reaches it, the forge's host keys pinned.
  const R = createRoom(H, name, {who: OPERATOR, text: genesis, files, remote, ...(overSsh(remote) ? {authRef: `ringi-key:${H.name}/${OPERATOR}`, hostKeys: H.d.access?.hostKeys} : {})})
  setConfig({room: name})
  const line = invite(R)
  return {profile: p, join: line ? `ringi join ${line} --as <agent>` : null}
}
export const use = (name: string): Room => {
  const R = roomNamed(name)
  setConfig({room: R.name})
  return R
}
// The room's store on this machine and everything kept for it: its endpoint and its readers' state. Sessions bound to
// it, here or elsewhere, leave it on their own when they find it gone (core/agents/sessions); a forge's copy is the
// access adapter's to delete.
export const erase = (R: Room): void => {
  deleteRoom(R)
  if (config().room === R.name) setConfig({room: null})
}
