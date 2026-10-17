// E8 catalogue records. These types and checks do not activate endpoint/2 or migrate an existing home.
import {createHash} from 'node:crypto'
import {badRegistration} from './registration-checks.ts'
import type {Key} from '../ports/state.ts'
import type {RoomEndpointV2} from '../ports/store.ts'
import type {RoomDirectory} from '../ports/location.ts'
import {canonical, parseAddress} from './address.ts'

declare const registration: unique symbol
export type RoomRegistrationId = string & {readonly [registration]: true}
export type RegistrationOwner = {name: string, genesis: string, trust: 'asserted' | 'signed', root?: string}
export type ReservationValue = null | boolean | number | string | ReservationValue[] | {[key: string]: ReservationValue}
export type ReservationRequest = {owner: RegistrationOwner, operation: string, parameters: Record<string, ReservationValue>}
export type RoomPreparation = {target: string, directory?: RoomDirectory, phase: 'allocated' | 'initializing'}
export type RoomReservation = {operation: string, generation: string, parameters: string, preparation?: RoomPreparation, provision?: {remote: string}}
export type RoomRegistration = {
  schema: 'ringi-registration/1'
  id: RoomRegistrationId
  address: string
  aliases: string[]
  name: string
  owner: RegistrationOwner
  reservation?: RoomReservation
  deletion?: {token: string, mode: 'managed' | 'unregister'}
} & ({phase: 'reserved', reservation: RoomReservation, endpoint?: never} | {phase: 'active', endpoint: RoomEndpointV2})

export const canonicalRoom = (address: string): string => {
  const parsed = parseAddress(address, 'lookup')
  if (parsed.kind === 'name' || canonical(parsed) !== address) return badRegistration('a canonical full address is required')
  return address
}
export const addressName = (address: string, name: string): void => {
  const parsed = parseAddress(address, 'lookup')
  if ((parsed.kind === 'local' || parsed.kind === 'remote') && parsed.room !== name) badRegistration('address/name mismatch')
}
export const registrationId = (address: string): RoomRegistrationId =>
  createHash('sha256').update(canonicalRoom(address)).digest('hex') as RoomRegistrationId
export const registrationKey = (id: RoomRegistrationId): Key => {
  if (!/^[a-f0-9]{64}$/.test(id)) return badRegistration('invalid registration id')
  return ['catalogue', 'rooms', id]
}
// A reader/seat/cache context must include the physical incarnation as well as the accepted room history.
export const registrationContext = (r: RoomRegistration): readonly string[] => r.phase === 'active'
  ? [r.id, r.address, r.owner.genesis, r.endpoint.genesis, r.endpoint.location.generation]
  : badRegistration('a reservation has no active reader context')

