// Local provider facts are auxiliary: registration/1 and its signed creation intent keep their original format.
import type {CatalogueRecords} from './catalogue-records.ts'
import {catalogueFailure as bad} from './catalogue-records.ts'
import {registrationKey} from './room-registration.ts'
import type {RoomRegistration, RoomRegistrationId} from './room-registration.ts'
import {record} from './registration-checks.ts'
import {repositoryId} from './provider-repository.ts'
import {withRemote} from './reservation-result.ts'

const current = (records: CatalogueRecords, id: RoomRegistrationId, generation: string): RoomRegistration => {
  const r = records.get(id)
  if (!r?.reservation || r.reservation.generation !== generation) return bad('provider reservation incarnation changed')
  return r
}
const savedId = (records: CatalogueRecords, r: RoomRegistration): string | undefined => {
  const v = records.state.read<unknown>([...registrationKey(r.id), 'provider'], null)
  if (v === null) return undefined
  if (!record(v) || Object.keys(v).length !== 2 || typeof v.repositoryId !== 'string' || !Object.hasOwn(v, 'generation')) return bad('invalid provider record')
  if (v.generation !== r.reservation!.generation) return bad('provider record belongs to another reservation incarnation')
  return repositoryId(v.repositoryId)
}
export const providerId = (records: CatalogueRecords, id: RoomRegistrationId, generation: string): string | undefined =>
  savedId(records, current(records, id, generation))

// Caller holds the catalogue lock. The ID is durable first; a crash before the locator write resumes only that ID.
export const bindProvider = (records: CatalogueRecords, id: RoomRegistrationId, generation: string, remote: string, value: string): RoomRegistration => {
  const r = current(records, id, generation), next = withRemote(r, remote), expected = repositoryId(value), old = savedId(records, r)
  if (r.deletion || r.phase === 'active' && r.endpoint.disposal) return bad('provider binding during disposal is refused')
  if (old !== undefined && old !== expected) return bad('provider repository id changed; saved identity is retained')
  if (old === undefined) {
    if (r.phase !== 'reserved' || r.reservation!.preparation || r.reservation!.provision) return bad('provider identity must be saved before repository allocation; no legacy identity is inferred')
    records.state.write([...registrationKey(id), 'provider'], {repositoryId: expected, generation})
  }
  return next === r ? next : records.save(next)
}
