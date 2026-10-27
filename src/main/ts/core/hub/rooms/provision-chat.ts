// Existing chat is checked through the signed transport, against a local creation witness, before provider writes.
import {fail} from '../../../lib/index.ts'
import {hubPorts} from '../ports/index.ts'
import type {TransportV4} from '../ports/store.ts'
import type {Hub} from './index.ts'
import type {RoomCreationSpec} from './repository-spec.ts'
import type {RoomRegistrationId} from './room-registration.ts'
import {roomCatalogue} from './catalogue-v2.ts'
import {checkPrepared, directoryLock} from './location-creation.ts'
import {roomRepositoryV4} from './repository-v2.ts'
import {readbackRoomV2} from './room-view-v2.ts'

export const checkProvisionedChat = (H: Hub, id: RoomRegistrationId, spec: RoomCreationSpec, transport: TransportV4): void => {
  const {state, roomFiles} = hubPorts()
  state.locked(`room-location-${id}`, () => {
    const r = roomCatalogue(state).get(id) ?? fail('no creation registration for existing chat')
    const directory = r.phase === 'active' ? r.endpoint.location.directory : r.reservation.preparation?.directory
    if (!directory || !roomFiles) return fail('existing chat has no locally witnessed room genesis; repository is retained untouched')
    state.locked(directoryLock(directory), () => {
      checkPrepared(roomFiles, directory.path, directory)
      const endpoint = r.phase === 'active' ? r.endpoint
        : roomRepositoryV4(H, transport, transport.open(H.dir, H.d), spec).recover!({registration: r, directory})
      const store = transport.open(directory.path, H.d, endpoint)
      store.sync()
      readbackRoomV2(H, endpoint, store)
      checkPrepared(roomFiles, directory.path, directory)
    })
  })
}
