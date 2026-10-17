// A true endpoint/2 view, never an endpoint/1 projection. It does not create an agent binding or medium grant.
import {fail} from '../../../lib/index.ts'
import {parseProfile} from '../work/index.ts'
import type {RoomEndpointV2, Store, StoreV4} from '../ports/store.ts'
import {checkedContractV4} from './contracts.ts'
import type {Hub, RoomV2} from './index.ts'
import type {RoomRegistration} from './room-registration.ts'
import {registrationContext} from './room-registration.ts'
import {checkedRegistration} from './registration-validation.ts'
import {checkEndpointV2} from './endpoint-v2.ts'
import {checkNamed, profileOf, membersOf, quorumOf} from './room-view.ts'
import {membershipAt} from './room-members.ts'
import {copyRecord} from './reservation.ts'

export const checkedRoomContractV4 = (H: Hub, store: Store) => {
  const result = checkedContractV4(H, store, 'git/4')
  if (result.main !== store.contractHead() || result.contract.store !== 'git/4') fail('git/4 contract checker returned another revision or layout')
  if (store.trust !== H.d.trust || result.contract.trust !== H.d.trust || result.contract.root !== H.d.root) fail('git/4 contract changed pinned trust or root')
  return result
}
export const readbackRoomV2 = (H: Hub, endpoint: RoomEndpointV2, store: Store) => {
  const e = checkEndpointV2(endpoint, H.d)
  if (e.disposal) fail('room disposal is in progress; no room is opened')
  if (store.trust !== e.trust) fail('selected store changed the pinned trust model')
  const {main, contract} = checkedRoomContractV4(H, store)
  const s = store.room(e.name) ?? fail('room endpoint has no verified chat branch')
  if (s.genesis !== e.genesis || s.base !== main) fail('ALARM room changed its pinned genesis or frozen contract')
  if (!store.extends(H.d.genesis, main)) fail('room contract does not descend from its pinned hub genesis')
  if (contract.trust !== e.trust || contract.root !== e.root) fail('room contract changed pinned trust or root')
  checkNamed(s, e.name)
  return {s, main, contract}
}
export const openedRoomV2 = (H: Hub, registration: RoomRegistration, store: StoreV4): RoomV2 => {
  const r = checkedRegistration(copyRecord(registration), registration.id)
  if (r.phase !== 'active') return fail('pending creation has no active Room view')
  const {s, main, contract} = readbackRoomV2(H, r.endpoint, store)
  const {name} = r
  return {hub: H, id: r.id, context: Object.freeze([...registrationContext(r)]), endpoint: r.endpoint, store, s,
    name, head: s.head, genesis: s.genesis, contractRev: main, contract,
    profile: parseProfile(profileOf(H, store, s, name), `room ${name}: profile`),
    members: membersOf(store, s, name, contract.store), membersAt: membershipAt(store, s, 'git/4'), quorum: quorumOf(s)}
}
