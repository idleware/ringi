// Address hashes can be reused; every metadata writer must also hold the exact active incarnation.
import {fail} from '../../../lib/index.ts'
import {hubPorts} from '../ports/index.ts'
import type {RoomV2} from './index.ts'
import {CatalogueRecords} from './catalogue-records.ts'
import type {RoomRegistration} from './room-registration.ts'
import {registrationContext} from './room-registration.ts'
import {equalRecord} from './reservation.ts'

export const matchingRegistration = (records: CatalogueRecords, R: RoomV2): RoomRegistration & {phase: 'active'} => {
  const r = records.get(R.id)
  if (r?.phase !== 'active' || !equalRecord({context: registrationContext(r)}, {context: R.context}) || !equalRecord(r.endpoint, R.endpoint)) return fail('registered metadata incarnation changed; nothing is written')
  return r
}
export const registeredMetadataChange = <T>(R: RoomV2, change: () => T): T => {
  const {state} = hubPorts()
  return state.locked('room-catalogue-v2', () => {
    const r = matchingRegistration(new CatalogueRecords(state), R)
    if (r.deletion || r.endpoint.disposal) fail('room disposal is in progress; no metadata is written')
    return change()
  })
}
