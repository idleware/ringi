// Repository construction/verification is injected. Metadata cannot turn a successful fetch into an admission.
import {fail, sameObject} from '../../../lib/index.ts'
import type {RoomFiles} from '../ports/location.ts'
import type {RoomEndpointV2} from '../ports/store.ts'
import {checkEndpointV2} from './endpoint-v2.ts'
import {checkPrepared} from './location-creation.ts'
import type {PreparedRoom} from './location-creation.ts'
import {copyRecord} from './reservation.ts'
import {parseAddress} from './address.ts'

export type RepositoryCreation = {
  create(prepared: PreparedRoom): RoomEndpointV2
  // An interrupted create is never re-executed blindly. Recovery must prove this exact operation and intent.
  recover?(prepared: PreparedRoom): RoomEndpointV2
  verify(endpoint: RoomEndpointV2): void
}
const bad = (why: string): never => fail(`room lifecycle: ${why}; no active registration is installed`)
export const completedEndpoint = (prepared: PreparedRoom, candidate: RoomEndpointV2, files: RoomFiles, verify: RepositoryCreation['verify']): RoomEndpointV2 => {
  const r = prepared.registration, e = copyRecord(checkEndpointV2(candidate, r.owner))
  if (e.address !== r.address || e.name !== r.name || e.location.generation !== r.reservation.generation) bad('created room does not match its reservation')
  const d = prepared.directory
  if (e.location.directory.path !== d.path || !sameObject(e.location.directory.identity, d.identity)) bad('created room changed its repository object')
  if (e.receipt || e.disposal) bad('repository callback supplied an unowned receipt or disposal')
  const target = r.reservation.preparation!.target
  checkPrepared(files, target, d)
  verify(copyRecord(e))
  checkPrepared(files, target, d)
  return {...e, receipt: {reservation: r.reservation.operation, address: e.address, genesis: e.genesis, directory: copyRecord(d)}}
}
export const verifyAdoption = (e: RoomEndpointV2, files: RoomFiles, verify: RepositoryCreation['verify']): void => {
  if (e.receipt || e.disposal) bad('joining a repository does not establish creation ownership')
  // The caller supplies the original selected path for an absolute address; metadata alone cannot retarget it.
  const selected = parseAddress(e.address, 'lookup')
  const target = selected.kind === 'path' ? selected.path : e.location.directory.path
  checkPrepared(files, target, e.location.directory)
  verify(copyRecord(e))
  checkPrepared(files, target, e.location.directory)
}
