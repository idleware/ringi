// Explicit room creation, attachment and local purge. Every installation preserves existing pins on failure.
import {hubPorts, locked} from '../ports/index.ts'
import {fail} from '../../../lib/index.ts'
import {ID_RE} from '../protocol/index.ts'
import type {RoomEndpoint} from '../ports/store.ts'
import {openContract} from './contracts.ts'
import {endpointRefusal} from './compat.ts'
import {openedRoom} from './room-view.ts'
import {endpointKey, roomDir, roomLock, transportFor, uniqueName} from './room-catalogue.ts'
import type {Hub, Room} from './index.ts'
const checkName = (H: Hub, name: string): void => {
  if (!ID_RE.test(name) || name === 'main' || name === 'chat') fail(`bad room name ${name}`)
  uniqueName(H, name)
}
const sameEndpoint = (name: string, old: RoomEndpoint | null, next: RoomEndpoint): void => {
  if (!old) return
  const identity = old.genesis === next.genesis && old.hubGenesis === next.hubGenesis
  if (!identity || old.store.path !== next.store.path) fail(`room ${name}: an endpoint already pins another history; nothing is replaced`)
}
// Where a room lives besides here: its remote, how this machine reaches it over SSH (`authRef`) and the host's pinned keys.
type Reach = {remote?: string, authRef?: string, hostKeys?: string[]}
const newEndpoint = (H: Hub, name: string, {remote, authRef, hostKeys}: Reach): RoomEndpoint => ({schema: 'ringi-room/1', name,
  hubGenesis: H.d.genesis, genesis: '', store: {path: 'store', ...(remote ? {remote} : {})}, ...(authRef ? {authRef} : {}), ...(hostKeys?.length ? {hostKeys} : {})})
export const createRoom = (H: Hub, name: string, {who, text, files, ...reach}: {who: string, text: string, files: Record<string, string>} & Reach): Room =>
  locked('room-names', () => locked(roomLock(H, name), () => {
    checkName(H, name)
    if (reach.remote && !H.signed) fail('a remote room requires a signed hub')
    const st = hubPorts().state
    if (st.list(['hub', H.name, 'rooms']).includes(name)) fail(`room ${name} exists; an unregistered repository is retained for review`)
    const {store: source} = openContract(H)
    const endpoint = newEndpoint(H, name, reach)
    const store = transportFor(H, endpoint).fork(roomDir(H, name), H.d, source, endpoint)
    endpoint.genesis = store.createRoom(name, who, text, files)
    const R = openedRoom(H, endpoint, store)
    st.write(endpointKey(H, name), endpoint)
    return R
  }))
export const attachRoom = (H: Hub, name: string, endpoint: RoomEndpoint): Room => locked('room-names', () => locked(roomLock(H, name), () => {
  checkName(H, name)
  const why = endpointRefusal(H.d, name, endpoint)
  if (why) fail(why)
  const st = hubPorts().state
  const old = st.read<RoomEndpoint | null>(endpointKey(H, name), null)
  sameEndpoint(name, old, endpoint)
  const t = transportFor(H, endpoint)
  const store = old ? t.open(roomDir(H, name), H.d, endpoint) : t.attachRoom(roomDir(H, name), H.d, endpoint)
  store.sync()
  const R = openedRoom(H, endpoint, store)
  st.write(endpointKey(H, name), endpoint)
  return R
}))
// The caller requires the operator's explicit local-purge confirmation. Missing remotes never invoke this.
export const deleteRoom = (R: Room): void => locked(roomLock(R.hub, R.name), () => {
  const current = hubPorts().state.read<RoomEndpoint | null>(endpointKey(R.hub, R.name), null)
  if (!current || current.genesis !== R.genesis || current.hubGenesis !== R.hub.d.genesis) fail('room endpoint moved before local purge; nothing is removed')
  hubPorts().state.remove(['hub', R.hub.name, 'rooms', R.name])
  hubPorts().state.remove(['readers', R.hub.d.genesis, R.genesis])
})
