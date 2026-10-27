// Fail closed on local records, including stale reservations and address/hash collisions.
import {sameObject} from '../../../lib/index.ts'
import {badRegistration as bad, checkOwner, record, roomName, token} from './registration-checks.ts'
import {addressName, canonicalRoom, registrationId} from './room-registration.ts'
import type {RoomRegistration, RoomRegistrationId, RoomReservation} from './room-registration.ts'
import {checkReservation} from './reservation.ts'
import {checkEndpointV2} from './endpoint-v2.ts'
import type {RoomEndpointV2} from '../ports/store.ts'

const checkAliases = (v: Record<string, unknown>): void => {
  if (!Array.isArray(v.aliases) || !v.aliases.every(x => typeof x === 'string' && canonicalRoom(x) === x)) bad('invalid aliases')
  const aliases = v.aliases as string[]
  if (new Set(aliases).size !== aliases.length || aliases.includes(v.address as string)) bad('invalid aliases')
}
const reservationMatches = (e: RoomEndpointV2, pending?: RoomReservation): void => {
  if (!pending) return
  if (e.location.generation !== pending.generation) bad('endpoint/reservation mismatch')
  if (e.receipt && e.receipt.reservation !== pending.operation) bad('endpoint/reservation mismatch')
  const directory = pending.preparation?.directory
  if (directory && (directory.path !== e.location.directory.path || !sameObject(directory.identity, e.location.directory.identity))) bad('endpoint/prepared-directory mismatch')
}
const checkPhase = (v: Record<string, unknown>): void => {
  const pending = v.reservation === undefined ? undefined : checkReservation(v.reservation)
  if (v.phase === 'reserved') {
    if (!pending || v.endpoint !== undefined || (v.aliases as string[]).length) bad('incomplete create reservation')
    return
  }
  if (v.phase !== 'active') bad('unknown registration phase')
  const e = checkEndpointV2(v.endpoint, checkOwner(v.owner))
  if (e.address !== v.address || e.name !== v.name) bad('endpoint/catalogue identity mismatch')
  if (e.receipt && !pending) bad('a creation receipt requires its durable reservation')
  reservationMatches(e, pending)
}
export const checkedRegistration = (value: unknown, id: RoomRegistrationId): RoomRegistration => {
  if (!record(value) || value.schema !== 'ringi-registration/1' || value.id !== id || typeof value.address !== 'string') return bad('invalid catalogue record')
  if (registrationId(value.address) !== id) return bad('address/id collision; nothing is replaced')
  checkAliases(value)
  if (!roomName(value.name)) return bad('invalid room name')
  addressName(value.address, value.name)
  checkOwner(value.owner)
  if (value.deletion !== undefined && (!record(value.deletion) || !token(value.deletion.token) || !['managed', 'unregister'].includes(value.deletion.mode as string))) bad('invalid deletion marker')
  checkPhase(value)
  return value as RoomRegistration
}
