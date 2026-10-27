// Explicit E8 catalogue, unused by current name-based callers. Mutations share one machine-local lock.
import {sameObject} from '../../../lib/index.ts'
import type {LocalState} from '../ports/state.ts'
import type {RoomFiles} from '../ports/location.ts'
import type {RoomEndpointV2} from '../ports/store.ts'
import {canonical, parseAddress} from './address.ts'
import type {RoomSelector} from './address.ts'
import {canonicalRoom, registrationId} from './room-registration.ts'
import type {RegistrationOwner, ReservationRequest, RoomRegistration, RoomRegistrationId} from './room-registration.ts'
import {CatalogueRecords, addresses, byAddress, catalogueFailure as bad} from './catalogue-records.ts'
import {copyRecord, reservationParameters} from './reservation.ts'
import {installRegistration} from './catalogue-install.ts'
import {bindRemote} from './reservation-result.ts'
import {bindProvider, providerId} from './provider-record.ts'

const checkLocation = (r: RoomRegistration & {phase: 'active'}, selector: RoomSelector, files: RoomFiles): void => {
  const selected = selector.kind === 'name' ? parseAddress(r.address, 'lookup') : selector
  if (selected.kind === 'path') {
    const actual = files.canonical(selected.path), pinned = r.endpoint.location.directory
    if (!actual || !sameObject(actual.identity, pinned.identity) || actual.path !== pinned.path) bad('previously registered path changed its repository object')
  }
  files.check(r.endpoint.location.directory)
}
class RoomCatalogue {
  private readonly records: CatalogueRecords
  private readonly state: LocalState
  constructor(state: LocalState) { this.state = state; this.records = new CatalogueRecords(state) }
  get(id: RoomRegistrationId): RoomRegistration | null { return this.records.get(id) }
  all(): RoomRegistration[] { return this.records.all() }
  forOperation(owner: RegistrationOwner, operation: string): RoomRegistration | null { return this.records.forOperation(owner, operation) }
  bindRemote(id: RoomRegistrationId, remote: string): RoomRegistration {
    return this.state.locked('room-catalogue-v2', () => bindRemote(this.records, id, remote))
  }
  providerId(id: RoomRegistrationId, generation: string): string | undefined {
    return this.state.locked('room-catalogue-v2', () => providerId(this.records, id, generation))
  }
  bindProvider(id: RoomRegistrationId, generation: string, remote: string, repositoryId: string): RoomRegistration {
    return this.state.locked('room-catalogue-v2', () => bindProvider(this.records, id, generation, remote, repositoryId))
  }
  // `choose` allocates only once, after checking the durable caller operation. No provider writes here.
  reserve(request: ReservationRequest, choose: () => {address: string, name: string, generation: string}): RoomRegistration {
    return this.state.locked('room-catalogue-v2', () => {
      const parameters = reservationParameters(request.parameters), old = this.forOperation(request.owner, request.operation)
      if (old) return old.reservation!.parameters === parameters ? old : bad('create retry changed its parameters')
      const chosen = choose(), address = canonicalRoom(chosen.address)
      if (byAddress(this.all(), address)) bad('address is already registered or reserved')
      return this.records.save({schema: 'ringi-registration/1', id: registrationId(address), address, aliases: [], name: chosen.name,
        owner: copyRecord(request.owner), phase: 'reserved', reservation: {operation: request.operation, generation: chosen.generation, parameters}})
    })
  }
  // Activation consumes its reservation; adoption has none and may never acquire a creation receipt.
  install(owner: RegistrationOwner, endpoint: RoomEndpointV2, operation?: string): RoomRegistration {
    return this.state.locked('room-catalogue-v2', () => installRegistration(this.records, owner, endpoint, operation))
  }
  select(selector: RoomSelector, files: RoomFiles): RoomRegistration {
    const entries = this.all()
    const matches = selector.kind === 'name' ? entries.filter(r => r.name === selector.room)
      : entries.filter(r => addresses(r).includes(canonical(selector)))
    // Pending records occupy their names too; do not silently select another room during a create or purge.
    if (matches.length !== 1) return bad(matches.length ? `ambiguous room; use one full address: ${matches.map(r => r.address).sort().join(', ')}` : 'unknown room')
    const r = matches[0]
    if (r.phase !== 'active' || r.endpoint.disposal || r.deletion) return bad('room creation or disposal is not complete')
    checkLocation(r, selector, files)
    return r
  }
}
export const roomCatalogue = (state: LocalState) => new RoomCatalogue(state)
