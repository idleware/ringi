// Future location-aware lifecycle. Current room-life.ts callers remain on endpoint/1 until coherent activation.
import {fail} from '../../../lib/index.ts'
import type {LocalState} from '../ports/state.ts'
import type {RoomFiles} from '../ports/location.ts'
import type {RoomEndpointV2} from '../ports/store.ts'
import {CatalogueRecords} from './catalogue-records.ts'
import {installRegistration} from './catalogue-install.ts'
import {checkEndpointV2} from './endpoint-v2.ts'
import {checkPrepared, createdRetry, directoryLock, markInitializing, prepareLocation} from './location-creation.ts'
import {completedEndpoint, verifyAdoption} from './location-install.ts'
import type {RepositoryCreation} from './location-install.ts'
import {disposeRegistration} from './location-disposal.ts'
import type {RegistrationOwner, RoomRegistration, RoomRegistrationId} from './room-registration.ts'
import {registrationKey} from './room-registration.ts'
import {copyRecord} from './reservation.ts'
import {checkOwner} from './registration-checks.ts'

class LocationLifecycle {
  private readonly records: CatalogueRecords
  private readonly files: RoomFiles
  constructor(state: LocalState, files: RoomFiles) { this.records = new CatalogueRecords(state); this.files = files }
  create(id: RoomRegistrationId, target: string, repository: RepositoryCreation): RoomRegistration {
    registrationKey(id)
    return this.records.state.locked(`room-location-${id}`, () => {
      const old = this.records.get(id)
      if (old?.phase === 'active') return this.records.state.locked(directoryLock(old.endpoint.location.directory), () => createdRetry(old, target, this.files, e => repository.verify(e)))
      const prepared = prepareLocation(this.records, this.files, id, target)
      return this.records.state.locked(directoryLock(prepared.directory), () => {
        const interrupted = prepared.registration.reservation.preparation!.phase === 'initializing'
        if (interrupted && !repository.recover) fail('interrupted room creation requires verified recovery; target and reservation are retained')
        const attempt = interrupted ? prepared : markInitializing(this.records, prepared)
        checkPrepared(this.files, target, prepared.directory)
        const candidate = interrupted ? repository.recover!(copyRecord(attempt)) : repository.create(copyRecord(attempt))
        const e = completedEndpoint(attempt, candidate, this.files, e => repository.verify(e))
        return this.records.state.locked('room-catalogue-v2', () => installRegistration(this.records, attempt.registration.owner, e, attempt.registration.reservation.operation))
      })
    })
  }
  adopt(owner: RegistrationOwner, endpoint: RoomEndpointV2, verify: RepositoryCreation['verify']): RoomRegistration {
    checkOwner(owner)
    const e = copyRecord(checkEndpointV2(endpoint, owner))
    return this.records.state.locked(directoryLock(e.location.directory), () => {
      verifyAdoption(e, this.files, verify)
      return this.records.state.locked('room-catalogue-v2', () => installRegistration(this.records, owner, e))
    })
  }
  dispose(expected: RoomRegistration & {phase: 'active'}, {confirmed}: {confirmed: true}): RoomRegistration {
    registrationKey(expected.id)
    return this.records.state.locked(`room-location-${expected.id}`, () => this.records.state.locked(directoryLock(expected.endpoint.location.directory),
      () => disposeRegistration(this.records, this.files, expected, confirmed)))
  }
}
export const locationLifecycle = (state: LocalState, files: RoomFiles) => new LocationLifecycle(state, files)
