// Explicit operator-facing local deletion. Recovery can use the retained registration without opening its repository.
import {fail} from '../../../lib/index.ts'
import {hubPorts} from '../ports/index.ts'
import type {RoomV2} from './index.ts'
import type {RoomRegistration} from './room-registration.ts'
import {ensureRoomHomeV5} from './registered-room.ts'
import {removeRegistration} from './registration-delete.ts'
import type {DeleteOptions, DeletedRegistration} from './registration-delete.ts'
import {CatalogueRecords} from './catalogue-records.ts'
import {matchingRegistration} from './registration-metadata.ts'

export const deleteRoomRegistration = (expected: RoomRegistration & {phase: 'active'}, options: DeleteOptions): DeletedRegistration => {
  ensureRoomHomeV5()
  const {state, roomFiles} = hubPorts()
  if (!roomFiles) return fail('room deletion requires the location port')
  return removeRegistration(state, roomFiles, expected, options)
}
export const deleteRegisteredRoom = (R: RoomV2, options: DeleteOptions): DeletedRegistration => {
  const {state} = hubPorts()
  const expected = matchingRegistration(new CatalogueRecords(state), R)
  return deleteRoomRegistration(expected, options)
}
export type {DeleteOptions, DeletedRegistration} from './registration-delete.ts'
