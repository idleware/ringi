// Activate a durable create reservation, or adopt a verified repository without claiming its ownership.
import type {RoomEndpointV2} from '../ports/store.ts'
import {CatalogueRecords, byAddress, registeredDirectory, catalogueFailure as bad} from './catalogue-records.ts'
import {checkOwner, ownerMatches} from './registration-checks.ts'
import {checkEndpointV2} from './endpoint-v2.ts'
import {copyRecord, equalRecord} from './reservation.ts'
import {registrationId} from './room-registration.ts'
import type {RegistrationOwner, RoomRegistration} from './room-registration.ts'

const sameRepository = (a: RoomEndpointV2, b: RoomEndpointV2): boolean => {
  const history = a.genesis === b.genesis && a.hubGenesis === b.hubGenesis && a.trust === b.trust && a.root === b.root
  const location = a.location.directory.path === b.location.directory.path && a.location.directory.identity === b.location.directory.identity
  const reach = a.store.path === b.store.path && a.store.remote === b.store.remote
  const identity = a.keyRef === b.keyRef && a.authRef === b.authRef && JSON.stringify(a.hostKeys) === JSON.stringify(b.hostKeys)
  return history && location && reach && identity
}
const activeRetry = (old: RoomRegistration & {phase: 'active'}, e: RoomEndpointV2, operation?: string): RoomRegistration => {
  if (old.deletion || old.endpoint.disposal) return bad('room disposal is in progress')
  if (operation !== undefined && old.reservation?.operation !== operation) return bad('create operation does not own this active registration')
  const aliasRetry = e.address !== old.address && operation === undefined && !e.receipt && sameRepository(old.endpoint, e)
  if (!equalRecord(old.endpoint, e) && !aliasRetry) bad('active endpoint pins differ')
  return old
}
const reservedMatches = (old: RoomRegistration, e: RoomEndpointV2, operation?: string): void => {
  if (old.phase !== 'reserved') return
  if (old.reservation.operation !== operation || old.reservation.generation !== e.location.generation || old.name !== e.name) bad('create reservation does not match activation')
  if (old.reservation.provision && e.store.remote !== old.reservation.provision.remote) bad('endpoint differs from the fixed provider result')
  const directory = old.reservation.preparation?.directory
  if (directory && (directory.path !== e.location.directory.path || directory.identity !== e.location.directory.identity)) bad('prepared repository identity changed before activation')
}
const aliasInstall = (records: CatalogueRecords, physical: RoomRegistration, owner: RegistrationOwner, e: RoomEndpointV2): RoomRegistration => {
  if (physical.phase !== 'active' || physical.endpoint.disposal || physical.deletion) return bad('repository object already pins another registration')
  if (!ownerMatches(physical.owner, owner) || !sameRepository(physical.endpoint, e)) return bad('repository object already pins another registration')
  return records.save({...physical, aliases: [...physical.aliases, e.address]})
}
export const installRegistration = (records: CatalogueRecords, owner: RegistrationOwner, e: RoomEndpointV2, operation?: string): RoomRegistration => {
  checkOwner(owner); checkEndpointV2(e, owner)
  const entries = records.all(), old = byAddress(entries, e.address)
  if (old && !ownerMatches(old.owner, owner)) bad('address belongs to another hub')
  if (old?.phase === 'active') return activeRetry(old, e, operation)
  if (old) reservedMatches(old, e, operation)
  else if (operation !== undefined || e.receipt) return bad('activation has no matching create reservation')
  const physical = entries.find(r => r.id !== old?.id && registeredDirectory(r)?.identity === e.location.directory.identity)
  if (physical && old) return bad('repository object already pins another registration')
  if (physical) return aliasInstall(records, physical, owner, e)
  return records.save({schema: 'ringi-registration/1', id: registrationId(e.address), address: e.address, name: e.name, owner: copyRecord(owner), aliases: [],
    ...(old?.reservation ? {reservation: old.reservation} : {}), phase: 'active', endpoint: copyRecord(e)})
}
