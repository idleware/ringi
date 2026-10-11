// rooms: the operator's rooms in a hub: list, create, switch, admit and remove members, archive, delete, move to a
// newer contract, and accept a new baseline for a log after reviewing an alarm.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {DEFAULT_PROFILE, parseProfile} from '../domain/profiles.ts'
import {HOME, OPERATOR, config, guard, locked, setConfig} from '../home/index.ts'
import {RESERVED_ROOMS, ROOM_MD, controlChange, profileText, room as roomOf, roomNames} from '../hub/index.ts'
import type {Hub, Room} from '../hub/index.ts'
import {Fail, fail, note} from '../lib/index.ts'
import {AGENT_RE, ID_RE, compose} from '../protocol/index.ts'
import {loadState, readerLock, saveState} from '../runtime/reader.ts'
import {allSessions, liveness} from '../runtime/session.ts'

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
export type RoomView = {name: string, current: boolean, archived: boolean, members: number, active: number, profile: string, genesis: string}
export const rooms = (H: Hub, {archived = false}: {archived?: boolean} = {}): RoomView[] => {
  const cur = config().room
  const view = (n: string, R: Room): RoomView => {
    const ss = allSessions().filter(s => s.hub === H.name && s.genesis === R.genesis)
    return {name: n, current: n === cur && !R.archived, archived: R.archived, members: Object.keys(R.members).length,
      active: ss.filter(s => liveness(s) === 'active').length, profile: R.profile.name, genesis: R.genesis}
  }
  const live = roomNames(H).flatMap(n => { const R = opens(H, n); return R ? [view(n, R)] : [] })
  const gone = archived ? roomNames(H, true).flatMap(n => { const R = opens(H, n); return R ? [view(n, R)] : [] }) : []
  return [...live, ...gone]
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
export const migrate = (H: Hub, name: string): string => {
  if (!H.store.migrateRoom) fail(`store ${H.store.type} cannot migrate rooms`)
  return locked(`hub-${H.name}`, () => H.store.migrateRoom!(name))
}
// Removing, archiving or deleting in a signed hub needs revocation published to every replica: not in this version.
const notSigned = (H: Hub, what: string) => { if (H.signed) fail(`room ${what} is not supported on signed hubs yet: a local change would come back with the next fetch`) }
export const admit = (H: Hub, R: Room, who: string, key: string): void => {
  if (!H.signed || !H.store.admit) fail('room admit is for signed hubs; on a local hub the operator\'s join adds members')
  if (!AGENT_RE.test(who)) fail(`bad agent id ${who}: lowercase letters, digits, - and _, no dot`)
  locked(`hub-${H.name}`, () => H.store.admit!(R.s, who, key))
}
export const remove = (H: Hub, R: Room, who: string): void => {
  notSigned(H, 'remove')
  if (!R.members[who]) fail(`${who} is not a member of ${R.name}`)
  if (who === OPERATOR) fail('the operator stays in every room')
  controlChange(R, OPERATOR, `remove ${who}`, m => { delete m[who] })
}
export const archive = (H: Hub, R: Room): string => {
  notSigned(H, 'archive')
  if (R.archived) fail(`${R.name} is already archived`)
  const name = `${R.name}@${R.genesis.slice(0, 8)}`
  locked(`hub-${H.name}`, () => H.store.archiveRoom(R.s, name))
  if (config().room === R.name) setConfig({room: null})
  return name
}
// The room and everything kept for it: in the store (deleteRoom) and its readers' state. The sessions bound to it,
// on this machine or another, leave it on their own when they find its branch gone (runtime/session.ts).
export const erase = (H: Hub, R: Room): void => {
  notSigned(H, 'delete')
  locked(`hub-${H.name}`, () => H.store.deleteRoom(R.s))
  guard(() => fs.rmSync(path.join(HOME, 'readers', H.name, R.genesis), {recursive: true, force: true}))
  if (config().room === R.name) setConfig({room: null})
}
// The room follows the hub's current contract from now on; nothing written before is reinterpreted.
export const rebase = (H: Hub, R: Room): void => controlChange(R, OPERATOR, `contract ${H.contract.version}`, () => {}, [['Contract', H.main]])
// The operator accepts a new baseline for one log, for every reader of the room, after reviewing an alarm. A signed
// store resets its transport pin too, keeping the displaced head as evidence; signatures are never waived.
export const forgetLog = (H: Hub, R: Room, id: string): number => {
  if (!ID_RE.test(id)) fail('usage: ringi forget <room>/<log>')
  if (H.signed) H.store.forgetLog?.(R.s, id)
  const dir = path.join(HOME, 'readers', H.name, R.genesis)
  let n = 0
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')) : []) {
    const reader = f.slice(0, -5)
    readerLock(R, reader, () => {
      const st = loadState(R, reader)
      if (st.heads?.[id]) {
        delete st.heads[id]
        st.alarms = (st.alarms ?? []).filter(a => !a.startsWith(`log ${id} `) && !a.startsWith(`log ${id}:`))
        saveState(R, reader, st)
        n++
      }
      H.store.unpin(R.s, reader, id)
    })
  }
  return n
}
