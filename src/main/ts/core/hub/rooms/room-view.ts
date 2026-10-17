// A selected, verified repository interpreted as one room with its frozen contract and profile.
import {DEFAULT_PROFILE, parseProfile} from '../work/index.ts'
import {fail, strictJson} from '../../../lib/index.ts'
import type {Member, RoomEndpoint, Store, StoredRoom} from '../ports/store.ts'
import {checkedContract, readProfileResource} from './contracts.ts'
import {contractAt} from './compat.ts'
import type {Hub, RoomV1} from './index.ts'
import {membershipAt} from './room-members.ts'
// The genesis names its room, in the root's hand: a history offered under another name is not that room.
export const checkNamed = (s: StoredRoom, name: string): void => {
  const subject = s.control[0]?.rev === s.genesis ? s.control[0].text.split('\n')[0] : '(none)'
  if (subject !== `room ${name}`) fail(`room ${name}: its genesis is "${subject}"; refusing a room's history under another name`)
}
// The room's profile is fixed when the room is made: its content is copied into the genesis control entry, so no
// later change of the hub's profiles or contract reinterprets the room's history. Rooms made before this carry none
// and use the default profile of the contract they were created on.
export const profileOf = (H: Hub, store: Store, s: StoredRoom, name: string): string => {
  const base = contractAt(store, H.name, s.base).profile ?? DEFAULT_PROFILE
  const fallback = (): string => base === DEFAULT_PROFILE ? readProfileResource(DEFAULT_PROFILE) : fail(`room ${name}: unknown profile ${base}`)
  return store.controlFile(s, 'profile.json', s.genesis) ?? store.contractFile(s.base, `profiles/${base}.json`) ?? fallback()
}
export const membersOf = (store: Store, s: StoredRoom, name: string, layout: string): Record<string, Member> =>
  store.roster(s)?.members ?? (layout === 'git/4' ? membershipAt(store, s, layout)(s.head)
    : strictJson<Record<string, Member>>(store.controlFile(s, 'members.json') ?? '{}', `room ${name}: members.json`))
// The root's control records set the quorum; the latest one counts.
export const quorumOf = (s: StoredRoom): number | null =>
  s.control.reduce<number | null>((q, rec) => Number(/^Quorum: ([1-9][0-9]?)$/m.exec(rec.text)?.[1] ?? NaN) || q, null)
export const openedRoom = (H: Hub, endpoint: RoomEndpoint, store: Store): RoomV1 => {
  const {name} = endpoint
  checkedContract(H, store)
  const s = store.room(name) ?? fail(`room ${name}: its endpoint has no chat branch`)
  if (store.contractHead() !== s.base) fail(`ALARM room ${name}: its frozen contract changed; nothing is delivered`)
  if (s.genesis !== endpoint.genesis) fail(`ALARM room ${name}: chat changes its pinned genesis`)
  checkNamed(s, name)
  const current = s.base
  if (!store.extends(current, store.contractHead())) fail(`room ${name}: its applied contract is outside main`)
  const contract = contractAt(store, H.name, current)
  return {hub: H, endpoint, store, s, name, head: s.head, genesis: s.genesis, contractRev: current, contract,
    profile: parseProfile(profileOf(H, store, s, name), `room ${name}: profile`), members: membersOf(store, s, name, contract.store),
    ...(contract.store === 'git/4' ? {membersAt: membershipAt(store, s, contract.store)} : {}), quorum: quorumOf(s)}
}
