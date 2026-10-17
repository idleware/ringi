// hub: hubs and rooms on top of any store. A hub is a directory with a descriptor (hub.json: which store, where,
// what this machine pins) beside its store. Its shared contract lives in the store (contract.json, profiles/*.json).
// hubs.ts reads descriptors and contracts, rooms.ts opens rooms with their profile,
// messages.ts turns stored records into messages and writes them (docs/spec/hub-1.md).

import {CAPABILITIES} from '../capabilities.ts'
import type {Profile} from '../work/index.ts'
import type {Descriptor, Member, Rev, RoomEndpoint, RoomEndpointV2, Store, StoreV4, StoredRoom} from '../ports/store.ts'
import type {RoomRegistrationId} from './room-registration.ts'

// The root principal of every hub and room (hub-1): the operator of the machine that made it.
export const OPERATOR = 'operator'

export const HUB_MAJOR = 2
export const PROTOCOL_MAJOR = 1
export const CAPS = new Set(Object.keys(CAPABILITIES))
export const RESERVED_ROOMS = new Set(['main', 'chat'])

export type Contract = {
  schema: 'ringi-hub'
  version: string
  protocol: number
  trust: 'asserted' | 'signed'
  capabilities?: string[]
  // How its store lays out what it keeps (`git/2`); none: the first layout of its type.
  store: string
  // The profile rooms use unless they name another (core/hub/work).
  profile?: string
  root?: string
}
export type Hub = {name: string, dir: string, d: Descriptor, signed: boolean}
type RoomView<Endpoint> = {
  hub: Hub
  endpoint: Endpoint
  store: Store
  s: StoredRoom
  name: string
  head: Rev
  genesis: Rev
  contractRev: Rev
  contract: Contract
  profile: Profile
  members: Record<string, Member>
  // On the removal-capable layout, membership under an accepted historical control; never a hosting lookup.
  membersAt?: (control: Rev) => Record<string, Member>
  // The quorum: how many agents (members besides the root) the room waits for before its work starts, or null.
  quorum: number | null
}
export type RoomV1 = RoomView<RoomEndpoint>
export type RoomV2 = Omit<RoomView<RoomEndpointV2>, 'store'> & {store: StoreV4, id: RoomRegistrationId, context: readonly string[]}
// Distribute the endpoint choice: a /2 room always carries its catalogue identity and full state context.
// Endpoint-neutral consumers can use Room; code that writes either machine layout must narrow it explicitly.
export type Room<Endpoint extends RoomEndpoint | RoomEndpointV2 = RoomEndpoint | RoomEndpointV2> =
  Endpoint extends RoomEndpointV2 ? RoomV2 : RoomV1
export const isRegisteredRoom = (R: Room): R is RoomV2 => R.endpoint.schema === 'ringi-room/2'
// Whether the room's work has started: it has the quorum of agents its genesis asked for (`Quorum`), or asked for none.
export const start = (R: Pick<Room, 'members' | 'quorum'>): {quorum: number | null, agents: number, started: boolean} => {
  const agents = Object.values(R.members).filter(m => m.role !== 'root').length
  return {quorum: R.quorum, agents, started: R.quorum === null || agents >= R.quorum}
}

export * from './hubs.ts'
export * from './compat.ts'
export * from './rooms.ts'
export * from './messages.ts'
export {openedRoomV2} from './room-view-v2.ts'
export {openRegisteredRoom, roomContextKey, registeredRoomLock} from './registered-room.ts'
export {roomRepositoryV4, repositoryIntent, provisionedRepository} from './repository-v2.ts'
export type {RoomCreationSpec} from './repository-v2.ts'
export {createRegisteredRoom, adoptRegisteredRoom} from './registered-life.ts'
export {registeredControlChange} from './registered-control.ts'
export type {RegisteredControl} from './registered-control.ts'
export {registeredTransportOf, legacyTransportOf, isRegisteredTransport} from './store-address.ts'
export * from '../usecases/config.ts'
export {HIDDEN} from '../protocol/index.ts'

export {deleteRegisteredRoom, deleteRoomRegistration} from './registered-delete.ts'
export type {DeleteOptions, DeletedRegistration} from './registered-delete.ts'
export {registeredMetadataChange} from './registration-metadata.ts'
