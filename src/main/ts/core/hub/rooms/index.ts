// hub: hubs and rooms on top of any store. A hub is a directory with a descriptor (hub.json: which store, where,
// what this machine pins) beside its store. Its shared contract lives in the store (contract.json, authority.json,
// profiles/*.json). hubs.ts reads descriptors and contracts, rooms.ts opens rooms with their profile and authority,
// messages.ts turns stored records into messages and writes them (docs/spec/hub-1.md).

import type * as D from '../decisions/index.ts'
import {CAPABILITIES} from '../capabilities.ts'
import type {Profile} from '../work/index.ts'
import type {Descriptor, Member, Rev, Store, StoredRoom} from '../ports/store.ts'

// The root principal of every hub and room (hub-1): the operator of the machine that made it.
export const OPERATOR = 'operator'

export const HUB_MAJOR = 1
export const PROTOCOL_MAJOR = 1
export const CAPS = new Set(Object.keys(CAPABILITIES))
export const RESERVED_ROOMS = new Set(['main', 'archive'])

export type Contract = {
  schema: 'ringi-hub'
  version: string
  protocol: number
  trust: 'asserted' | 'signed'
  capabilities?: string[]
  // How its store lays out what it keeps (`git/2`); none: the first layout of its type.
  store?: string
  // The profile rooms use unless they name another (core/hub/work).
  profile?: string
  root?: string
  authority: D.Authority
}
export type Hub = {name: string, dir: string, d: Descriptor, store: Store, main: Rev, contract: Contract, signed: boolean}
export type Room = {
  hub: Hub
  s: StoredRoom
  name: string
  archived: boolean
  head: Rev
  genesis: Rev
  contractRev: Rev
  contract: Contract
  authorityAt: D.AuthorityAt
  profile: Profile
  members: Record<string, Member>
  // The quorum: how many agents (members besides the root) the room waits for before its work starts, or null.
  quorum: number | null
}
// Whether the room's work has started: it has the quorum of agents its genesis asked for (`Quorum`), or asked for none.
export const start = (R: Pick<Room, 'members' | 'quorum'>): {quorum: number | null, agents: number, started: boolean} => {
  const agents = Object.values(R.members).filter(m => m.role !== 'root').length
  return {quorum: R.quorum, agents, started: R.quorum === null || agents >= R.quorum}
}

export * from './hubs.ts'
export * from './compat.ts'
export * from './rooms.ts'
export * from './messages.ts'
export * from '../usecases/config.ts'
export {HIDDEN} from '../protocol/index.ts'
