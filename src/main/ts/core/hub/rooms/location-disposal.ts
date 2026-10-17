// Durable disposal lives in the endpoint. Unsupported or ambiguous purge leaves every metadata record intact.
import {fail} from '../../../lib/index.ts'
import type {RoomFiles} from '../ports/location.ts'
import type {RoomEndpointV2} from '../ports/store.ts'
import {CatalogueRecords} from './catalogue-records.ts'
import type {RoomRegistration} from './room-registration.ts'
import {copyRecord, equalRecord} from './reservation.ts'
import {checkPrepared} from './location-creation.ts'

const bad = (why: string): never => fail(`room disposal: ${why}; local registration is retained`)
const pins = (e: RoomEndpointV2): RoomEndpointV2 => { const result = {...e}; delete result.disposal; return result }
const current = (records: CatalogueRecords, expected: RoomRegistration & {phase: 'active'}): RoomRegistration & {phase: 'active'} => {
  const r = records.get(expected.id)
  if (r?.phase !== 'active' || !equalRecord(r.owner, expected.owner) || !equalRecord(pins(r.endpoint), pins(expected.endpoint))) return bad('endpoint moved before local purge')
  if (!r.endpoint.receipt || !r.reservation) return bad('this replica has no creation receipt; safe purge is unsupported')
  return r
}
export const disposeRegistration = (records: CatalogueRecords, files: RoomFiles, expected: RoomRegistration & {phase: 'active'}, confirmed: boolean): RoomRegistration => {
  if (!confirmed) bad('explicit local-purge confirmation is required')
  let r = records.state.locked('room-catalogue-v2', () => {
    const found = current(records, expected)
    if (found.endpoint.disposal) return found
    const receipt = found.endpoint.receipt!
    checkPrepared(files, found.reservation!.preparation?.target ?? receipt.directory.path, receipt.directory)
    return records.save({...found, endpoint: {...found.endpoint, disposal: {phase: 'prepared', receipt: copyRecord(receipt)}}}) as RoomRegistration & {phase: 'active'}
  })
  if (r.endpoint.disposal!.phase === 'prepared') {
    const receipt = r.endpoint.receipt!
    checkPrepared(files, r.reservation!.preparation?.target ?? receipt.directory.path, receipt.directory)
    files.purge(receipt, records.state.root)
    if (files.canonical(receipt.directory.path) !== null) bad('purge did not leave the selected repository absent')
    r = records.state.locked('room-catalogue-v2', () => {
      const found = current(records, expected)
      return records.save({...found, endpoint: {...found.endpoint, disposal: {phase: 'repository-removed', receipt: copyRecord(receipt)}}}) as RoomRegistration & {phase: 'active'}
    })
  }
  if (files.canonical(r.endpoint.receipt!.directory.path) !== null) bad('repository path reappeared after purge')
  // LocalState.remove is a non-atomic recursive operation. Retain the durable endpoint and related metadata
  // until a separately verified finalizer exists; a successful repository purge never pretends to clear it.
  return r
}
