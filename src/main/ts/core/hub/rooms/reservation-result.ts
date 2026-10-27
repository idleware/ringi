// Requested parameters never change. A provider's locator is bound once, before repository initialization.
import type {CatalogueRecords} from './catalogue-records.ts'
import {catalogueFailure as bad} from './catalogue-records.ts'
import type {ReservationValue, RoomRegistration, RoomRegistrationId, RoomReservation} from './room-registration.ts'
import {record} from './registration-checks.ts'
import {parseAddress} from './address.ts'
import {reservationParameters} from './reservation.ts'
import {provisionedRepository} from './repository-spec.ts'
import type {RoomCreationSpec} from './repository-spec.ts'
import {provisionRemote} from './provision-remote.ts'

export const resolvedRepository = (r: RoomReservation): Record<string, ReservationValue> => {
  const requested = JSON.parse(r.parameters).repository
  if (!record(requested)) return bad('reservation has no repository intent')
  if (!r.provision) return requested as Record<string, ReservationValue>
  const reach = requested.reach ?? {}
  if (!record(reach) || reach.remote !== undefined) return bad('late provision result conflicts with the requested repository')
  return provisionedRepository(requested as RoomCreationSpec, r.provision.remote) as unknown as Record<string, ReservationValue>
}
export const resolvedIntent = (r: RoomReservation): string => r.provision
  ? reservationParameters({parameters: JSON.parse(r.parameters), provision: r.provision}) : r.parameters

export const withRemote = (r: RoomRegistration | null, value: string): RoomRegistration => {
  const remote = provisionRemote(value), provision = {remote}
  if (!r?.reservation) return bad('no reservation for a provider result')
  const old = r.reservation.provision
  if (old) return old.remote === remote ? r : bad('provider result changed; reserved remote is retained')
  if (r.phase !== 'reserved' || r.reservation.preparation) return bad('provider result must be fixed before repository allocation')
  if (r.owner.trust !== 'signed' || parseAddress(r.address, 'lookup').kind !== 'remote') return bad('late provisioning requires a signed room in a space')
  // Validate that the caller reserved an unresolved repository intent, before making this one-time addition.
  resolvedRepository({...r.reservation, provision})
  return {...r, reservation: {...r.reservation, provision}}
}
export const bindRemote = (records: CatalogueRecords, id: RoomRegistrationId, value: string): RoomRegistration => {
  const r = records.get(id), next = withRemote(r, value)
  return next === r ? next : records.save(next)
}
