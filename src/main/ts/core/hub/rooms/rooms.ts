// rooms: a room opened with its contract, profile, members and quorum; and the root's control changes.

import {DEFAULT_PROFILE, parseProfile} from '../work/index.ts'
import {locked} from '../ports/index.ts'
import {fail, strictJson} from '../../../lib/index.ts'
import {compose} from '../protocol/index.ts'
import type {Member, Rev, StoredRoom} from '../ports/store.ts'
import {readProfileResource} from './hubs.ts'
import {contractAt} from './compat.ts'
import type {Hub, Room} from './index.ts'

export const roomNames = (H: Hub): string[] => H.store.roomNames()
const missing = (H: Hub, name: string, quiet: boolean): null =>
  quiet ? null : fail(`no room ${name} in hub ${H.name}; rooms: ${roomNames(H).join(', ') || 'none'}`)
// The genesis names its room, in the root's hand: a history offered under another name is not that room.
const checkNamed = (s: StoredRoom, name: string): void => {
  const subject = s.control[0]?.rev === s.genesis ? s.control[0].text.split('\n')[0] : '(none)'
  if (subject !== `room ${name}`) fail(`room ${name}: its genesis is "${subject}"; refusing a room's history under another name`)
}
// The contract the room follows: the hub contract it was created on, or the last one the operator moved it to.
const contractRev = (s: StoredRoom): Rev =>
  s.control.reduce<Rev>((current, rec) => /^Contract: ([0-9a-f]{40,64})$/m.exec(rec.text)?.[1] ?? current, s.base)
// The room's profile is fixed when the room is made: its content is copied into the genesis control entry, so no
// later change of the hub's profiles or contract reinterprets the room's history. Rooms made before this carry none
// and use the default profile of the contract they were created on.
const profileOf = (H: Hub, s: StoredRoom, name: string): string => {
  const base = contractAt(H.store, H.name, s.base).profile ?? DEFAULT_PROFILE
  const fallback = (): string => base === DEFAULT_PROFILE ? readProfileResource(DEFAULT_PROFILE) : fail(`room ${name}: unknown profile ${base}`)
  return H.store.controlFile(s, 'profile.json', s.genesis) ?? H.store.contractFile(s.base, `profiles/${base}.json`) ?? fallback()
}
const membersOf = (H: Hub, s: StoredRoom, name: string): Record<string, Member> =>
  H.store.roster(s)?.members ?? strictJson<Record<string, Member>>(H.store.controlFile(s, 'members.json') ?? '{}', `room ${name}: members.json`)
// The root's control records set the quorum; the latest one counts.
const quorumOf = (s: StoredRoom): number | null =>
  s.control.reduce<number | null>((q, rec) => Number(/^Quorum: ([1-9][0-9]?)$/m.exec(rec.text)?.[1] ?? NaN) || q, null)
export const openRoom = (H: Hub, name: string | null | undefined, {quiet = false}: {quiet?: boolean} = {}): Room | null => {
  if (!name) return fail('no room: the operator creates one with ringi room create <id>, or picks one with ringi room switch <id>')
  const s = H.store.room(name)
  if (!s) return missing(H, name, quiet)
  checkNamed(s, name)
  const current = contractRev(s)
  const contract = current === H.main ? H.contract : contractAt(H.store, H.name, current)
  return {hub: H, s, name, head: s.head, genesis: s.genesis, contractRev: current, contract,
    profile: parseProfile(profileOf(H, s, name), `room ${name}: profile`), members: membersOf(H, s, name), quorum: quorumOf(s)}
}
export const room = (H: Hub, name: string | null | undefined): Room => openRoom(H, name)!
export const ROOM_MD = (name: string): string => `# room ${name}\n\nA ringi room: members.json lists who takes part; profile.json is what a piece of work is here, fixed when the room was made.\n`
export const profileText = (H: Hub, name: string): string | null =>
  H.store.contractFile(H.main, `profiles/${name}.json`) ?? (name === DEFAULT_PROFILE ? readProfileResource(DEFAULT_PROFILE) : null)
// A control change under the hub lock. In a signed room membership changes only through `room admit`.
export const controlChange = (R: Room, who: string, subject: string, mutate: (m: Record<string, Member>) => void, extra: Array<[string, string]> = []): void =>
  locked(`hub-${R.hub.name}`, () => {
    const s = R.hub.store.room(R.name) ?? fail(`room ${R.name} is gone`)
    const members = strictJson<Record<string, Member>>(R.hub.store.controlFile(s, 'members.json') ?? '{}', `room ${R.name}: members.json`)
    const before = JSON.stringify(members)
    mutate(members)
    if (R.hub.signed && JSON.stringify(members) !== before) fail('in a signed room, membership changes only by ringi room admit')
    R.head = R.hub.store.updateControl(s, who, compose(subject, [['To', '*'], ['Kind', 'room'], ...extra]), {'members.json': JSON.stringify(members, null, 2) + '\n'})
    R.members = members
  })
