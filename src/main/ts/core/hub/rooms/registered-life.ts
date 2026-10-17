// High-level E8 transactions consume an existing complete reservation, and never allocate a provider or choose a room.
import {fail} from '../../../lib/index.ts'
import {hubPorts} from '../ports/index.ts'
import type {RoomEndpointV2, TransportV4} from '../ports/store.ts'
import type {Hub, RoomV2} from './index.ts'
import type {RoomRegistrationId} from './room-registration.ts'
import {locationLifecycle} from './location-life.ts'
import {roomRepositoryV4, repositoryIntent} from './repository-v2.ts'
import type {RoomCreationSpec} from './repository-v2.ts'
import {readbackRoomV2} from './room-view-v2.ts'
import {ensureRoomHomeV5, openRegisteredRoom} from './registered-room.ts'
import {roomCatalogue} from './catalogue-v2.ts'
import {ownerMatches} from './registration-checks.ts'
import {reservationParameters} from './reservation.ts'
import {resolvedRepository} from './reservation-result.ts'

export const createRegisteredRoom = (H: Hub, id: RoomRegistrationId, target: string, transport: TransportV4, spec: RoomCreationSpec): RoomV2 => {
  ensureRoomHomeV5()
  const {state, roomFiles} = hubPorts()
  if (!roomFiles || !H.d.contract) return fail('room creation requires the location port and an explicit operator contract source')
  const reserved = roomCatalogue(state).get(id)
  if (!reserved?.reservation || !ownerMatches(reserved.owner, H.d)) return fail('no creation reservation for this pinned hub')
  if (reservationParameters(resolvedRepository(reserved.reservation)) !== reservationParameters(repositoryIntent(spec))) fail('repository builder differs from the durable complete create intent')
  const source = transport.open(H.dir, H.d)
  source.sync()
  const r = locationLifecycle(state, roomFiles).create(id, target, roomRepositoryV4(H, transport, source, spec))
  return openRegisteredRoom(H, r.address, transport)
}
export const adoptRegisteredRoom = (H: Hub, endpoint: RoomEndpointV2, transport: TransportV4): RoomV2 => {
  ensureRoomHomeV5()
  const {state, roomFiles} = hubPorts()
  if (!roomFiles) return fail('room adoption requires the location port')
  const r = locationLifecycle(state, roomFiles).adopt(H.d, endpoint, e => readbackRoomV2(H, e, transport.open(e.location.directory.path, H.d, e)))
  // Physical aliases may have selected a primary id/address. Never hash the proposed alias for invitation writes.
  return openRegisteredRoom(H, r.address, transport)
}
