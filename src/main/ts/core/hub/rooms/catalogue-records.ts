// Catalogue persistence, separate from selection and installation. No repository is opened or removed here.
import {fail, objectOf} from '../../../lib/index.ts'
import type {LocalState} from '../ports/state.ts'
import {registrationKey} from './room-registration.ts'
import type {RegistrationOwner, RoomRegistration, RoomRegistrationId} from './room-registration.ts'
import {checkedRegistration} from './registration-validation.ts'
import {checkOwner, ownerMatches, record, token} from './registration-checks.ts'
import {copyRecord} from './reservation.ts'

export const catalogueFailure = (why: string): never => fail(`room catalogue: ${why}; nothing is replaced`)
export const addresses = (r: RoomRegistration): string[] => [r.address, ...r.aliases]
export const registeredDirectory = (r: RoomRegistration) => r.phase === 'active' ? r.endpoint.location.directory : r.reservation.preparation?.directory
export const byAddress = (entries: RoomRegistration[], address: string): RoomRegistration | undefined => {
  const found = entries.filter(r => addresses(r).includes(address))
  if (found.length > 1) catalogueFailure('duplicate address registrations')
  return found[0]
}
const uniqueRecords = (entries: RoomRegistration[]): void => {
  const names = new Set<string>(), physical = new Set<string>()
  for (const r of entries) {
    for (const address of addresses(r)) {
      if (names.has(address)) catalogueFailure('duplicate address registrations')
      names.add(address)
    }
    const identity = registeredDirectory(r)?.identity, object = identity && objectOf(identity)
    if (!object) continue
    if (physical.has(object)) catalogueFailure('duplicate repository object registrations')
    physical.add(object)
  }
}
export class CatalogueRecords {
  readonly state: LocalState
  constructor(state: LocalState) { this.state = state }
  get(id: RoomRegistrationId): RoomRegistration | null {
    const raw = this.state.read<unknown>([...registrationKey(id), 'registration'], null)
    return raw === null ? null : copyRecord(checkedRegistration(raw, id))
  }
  all(): RoomRegistration[] {
    const entries = this.state.list(['catalogue', 'rooms']).map(id =>
      this.get(id as RoomRegistrationId) ?? catalogueFailure('missing registration record'))
    uniqueRecords(entries)
    return entries
  }
  save(r: RoomRegistration): RoomRegistration {
    checkedRegistration(r, r.id)
    const key = [...registrationKey(r.id), 'registration'], prior = this.state.read<unknown>(key, null)
    if (prior !== null && (!record(prior) || prior.address !== r.address)) catalogueFailure('address/id collision')
    this.state.write(key, copyRecord(r))
    return copyRecord(r)
  }
  forOperation(owner: RegistrationOwner, operation: string): RoomRegistration | null {
    checkOwner(owner)
    if (!token(operation)) catalogueFailure('invalid create operation')
    const found = this.all().filter(r => ownerMatches(r.owner, owner) && r.reservation?.operation === operation)
    if (found.length > 1) catalogueFailure('duplicate create operation')
    return found[0] ?? null
  }
}
