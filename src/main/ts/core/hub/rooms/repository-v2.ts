// Real lifecycle callbacks. A signed genesis commits to the complete durable local intent without publishing it.
import {createHash} from 'node:crypto'
import {fail} from '../../../lib/index.ts'
import {checkOutgoing, compose} from '../protocol/index.ts'
import type {RoomEndpointV2, Store, StoreV4, TransportV4} from '../ports/store.ts'
import type {PreparedRoom} from './location-creation.ts'
import type {RepositoryCreation} from './location-install.ts'
import {reservationParameters, copyRecord} from './reservation.ts'
import type {ReservationValue} from './room-registration.ts'
import type {Hub} from './index.ts'
import {ownerMatches} from './registration-checks.ts'
import {checkedRoomContractV4, readbackRoomV2} from './room-view-v2.ts'
import {resolvedIntent, resolvedRepository} from './reservation-result.ts'

import type {RoomCreationSpec} from './repository-spec.ts'
export type {RoomCreationSpec} from './repository-spec.ts'
export {provisionedRepository} from './repository-spec.ts'

// Place this under parameters.repository when reserving. Other parameters retain invitees/modes/ids unchanged.
export const repositoryIntent = (spec: RoomCreationSpec): Record<string, ReservationValue> =>
  JSON.parse(reservationParameters(spec as unknown as Record<string, ReservationValue>))
const intent = (H: Hub, p: PreparedRoom, spec: RoomCreationSpec): string => {
  if (!ownerMatches(p.registration.owner, H.d)) fail('creation reservation belongs to another pinned hub')
  if (reservationParameters(resolvedRepository(p.registration.reservation)) !== reservationParameters(repositoryIntent(spec))) fail('repository builder differs from the durable complete create intent')
  return createHash('sha256').update(resolvedIntent(p.registration.reservation)).digest('hex')
}
const genesisText = (H: Hub, p: PreparedRoom, spec: RoomCreationSpec): string => {
  if (spec.quorum !== undefined && (!Number.isInteger(spec.quorum) || spec.quorum < 1 || spec.quorum > 99)) fail('invalid create quorum')
  const r = p.registration, record = compose(`room ${r.name}` + (spec.description ? `\n\n${spec.description}` : ''), [
    ['To', '*'], ['Kind', 'room'], ['Quorum', spec.quorum === undefined ? undefined : String(spec.quorum)],
    ['Creation-Id', r.reservation.operation], ['Creation-Intent', intent(H, p, spec)],
    ['Creation-Generation', r.reservation.generation], ['Room-Address', r.address],
  ])
  checkOutgoing(record, () => false)
  return record
}
const endpointFor = (H: Hub, p: PreparedRoom, spec: RoomCreationSpec): RoomEndpointV2 => ({
  schema: 'ringi-room/2', address: p.registration.address, name: p.registration.name, hubGenesis: H.d.genesis,
  genesis: '', trust: H.d.trust, ...(H.d.root ? {root: H.d.root} : {}),
  location: {directory: copyRecord(p.directory), generation: p.registration.reservation.generation},
  store: {path: 'store', ...(spec.reach?.remote ? {remote: spec.reach.remote} : {})},
  ...(spec.reach?.keyRef ? {keyRef: spec.reach.keyRef} : {}), ...(spec.reach?.authRef ? {authRef: spec.reach.authRef} : {}),
  ...(spec.reach?.hostKeys ? {hostKeys: [...spec.reach.hostKeys]} : {}),
})
const recovery = (H: Hub, p: PreparedRoom, spec: RoomCreationSpec, store: StoreV4, endpoint: RoomEndpointV2): RoomEndpointV2 => {
  const room = store.room(endpoint.name) ?? fail('interrupted repository has no completed room genesis; retained without recreating it')
  if (room.control[0]?.rev !== room.genesis || room.control[0].text.trimEnd() !== genesisText(H, p, spec).trimEnd()) fail('interrupted repository does not prove this exact operation, address, generation and intent')
  for (const [file, text] of Object.entries(spec.files)) {
    if (store.file(room.genesis, file).toString('utf8') !== text) fail('interrupted genesis differs from the reserved creation files')
  }
  endpoint.genesis = room.genesis
  if (room.base !== spec.contract) fail('interrupted genesis changed the reserved frozen contract')
  readbackRoomV2(H, endpoint, store)
  return endpoint
}
export const roomRepositoryV4 = (H: Hub, transport: TransportV4, source: Store, spec: RoomCreationSpec): RepositoryCreation => {
  const creation = copyRecord(spec)
  if (transport.layout !== 'git/4') fail('room lifecycle requires explicit git/4 transport')
  checkedRoomContractV4(H, source)
  if (source.contractHead() !== creation.contract) fail('operator contract changed from the reserved creation revision')
  return {
    create(p) {
      const text = genesisText(H, p, creation), endpoint = endpointFor(H, p, creation)
      const store = transport.fork(p.directory.path, H.d, source, endpoint)
      endpoint.genesis = store.createRoom(endpoint.name, 'operator', text, creation.files)
      readbackRoomV2(H, endpoint, store)
      return endpoint
    },
    recover(p) {
      genesisText(H, p, creation)
      const endpoint = endpointFor(H, p, creation), store = transport.recoverPrepared(p.directory.path, H.d, endpoint)
      return recovery(H, p, creation, store, endpoint)
    },
    verify(endpoint) {readbackRoomV2(H, endpoint, transport.open(endpoint.location.directory.path, H.d, endpoint))},
  }
}
