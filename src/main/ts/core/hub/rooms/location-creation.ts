// Future lifecycle preparation. Its witnesses live in the create reservation, never in a shared scratch directory.
import {fail} from '../../../lib/index.ts'
import {createHash} from 'node:crypto'
import type {RoomDirectory, RoomFiles} from '../ports/location.ts'
import type {RoomEndpointV2} from '../ports/store.ts'
import {parseAddress} from './address.ts'
import {CatalogueRecords, registeredDirectory} from './catalogue-records.ts'
import type {RoomRegistration, RoomRegistrationId} from './room-registration.ts'
import {copyRecord} from './reservation.ts'

export type PreparedRoom = {registration: RoomRegistration & {phase: 'reserved'}, directory: RoomDirectory}
type PendingRoom = PreparedRoom['registration']
const bad = (why: string): never => fail(`room creation: ${why}; target and reservation are retained`)
export const directoryLock = (directory: RoomDirectory): string => 'room-object-' + createHash('sha256').update(directory.identity).digest('hex')
export const checkPrepared = (files: RoomFiles, target: string, directory: RoomDirectory): void => {
  const actual = files.canonical(target)
  if (actual?.path !== directory.path || actual.identity !== directory.identity) bad('target disappeared or changed its directory object')
  files.check(directory)
}
const withPreparation = (records: CatalogueRecords, r: RoomRegistration & {phase: 'reserved'}, target: string, directory?: RoomDirectory): RoomRegistration & {phase: 'reserved'} => {
  const next = {...r, reservation: {...r.reservation, preparation: {target, ...(directory ? {directory} : {}), phase: 'allocated' as const}}}
  return records.save(next) as RoomRegistration & {phase: 'reserved'}
}
const pendingTarget = (records: CatalogueRecords, id: RoomRegistrationId, target: string): PendingRoom => {
  const r = records.get(id)
  if (r?.phase !== 'reserved') return bad('no matching pending reservation')
  const address = parseAddress(r.address, 'lookup')
  if (address.kind === 'path' && address.path !== target) bad('target differs from its absolute public address')
  const previous = r.reservation.preparation
  if (previous && previous.target !== target) bad('retry changed its repository target')
  return previous ? r : withPreparation(records, r, target)
}
export const prepareLocation = (records: CatalogueRecords, files: RoomFiles, id: RoomRegistrationId, target: string): PreparedRoom =>
  records.state.locked('room-catalogue-v2', () => {
    let r = pendingTarget(records, id, target)
    const previous = r.reservation.preparation
    const directory = previous?.directory ?? files.createLeaf(target, records.state.root)
    checkPrepared(files, target, directory)
    if (records.all().some(other => other.id !== id && registeredDirectory(other)?.identity === directory.identity)) bad('repository object is already registered elsewhere')
    if (!previous?.directory) r = withPreparation(records, r, target, directory)
    return {registration: copyRecord(r), directory: copyRecord(directory)}
  })
export const markInitializing = (records: CatalogueRecords, prepared: PreparedRoom): PreparedRoom => records.state.locked('room-catalogue-v2', () => {
  const r = records.get(prepared.registration.id)
  if (r?.phase !== 'reserved' || r.reservation.preparation?.directory?.identity !== prepared.directory.identity) return bad('reservation moved before initialization')
  const next = {...r, reservation: {...r.reservation, preparation: {...r.reservation.preparation, phase: 'initializing' as const}}}
  return {...prepared, registration: records.save(next) as RoomRegistration & {phase: 'reserved'}}
})
export const createdRetry = (r: RoomRegistration & {phase: 'active'}, target: string, files: RoomFiles, verify: (e: RoomEndpointV2) => void): RoomRegistration => {
  if (r.reservation?.preparation?.target !== target || r.endpoint.disposal || r.deletion) bad('active room does not match this create retry')
  checkPrepared(files, target, r.endpoint.location.directory)
  verify(copyRecord(r.endpoint))
  checkPrepared(files, target, r.endpoint.location.directory)
  return copyRecord(r)
}
