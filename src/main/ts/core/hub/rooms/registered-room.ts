// Catalogue selection pins the physical object before cache lookup. All identity dimensions survive aliases.
import {fail} from '../../../lib/index.ts'
import {hubPorts} from '../ports/index.ts'
import type {StoreV4, TransportV4} from '../ports/store.ts'
import {roomCatalogue} from './catalogue-v2.ts'
import {parseAddress} from './address.ts'
import {ownerMatches} from './registration-checks.ts'
import type {Hub, RoomV2} from './index.ts'
import type {RoomRegistration} from './room-registration.ts'
import {registrationContext} from './room-registration.ts'
import {openedRoomV2} from './room-view-v2.ts'
import type {LocalState} from '../ports/state.ts'
import {contextToken} from './room-context.ts'

const selected = new WeakMap<LocalState, WeakMap<TransportV4, Map<string, StoreV4>>>()
export const ensureRoomHomeV5 = (): void => {
  const state = hubPorts().state
  if (state.read<{version?: number}>(['home'], {}).version !== 5) fail('registered rooms require an explicit home/5; existing homes are not migrated or reinterpreted')
  state.ensure()
}
export const roomContextKey = (R: Pick<RoomV2, 'context'>, category: string, actor?: string): readonly string[] => {
  if (!/^[a-z][a-z0-9-]*$/.test(category)) fail('invalid room context category')
  if (actor !== undefined && !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(actor)) fail('invalid room context actor')
  // Public addresses contain separators; only their full-context commitment enters a LocalState path segment.
  return ['room-contexts', contextToken(R), category, ...(actor === undefined ? [] : [actor])]
}
export const registeredRoomLock = (R: Pick<RoomV2, 'context'>): string =>
  'registered-room-' + contextToken(R)
const storeFor = (H: Hub, r: RoomRegistration & {phase: 'active'}, transport: TransportV4): StoreV4 => {
  const state = hubPorts().state, transports = selected.get(state) ?? new WeakMap<TransportV4, Map<string, StoreV4>>()
  selected.set(state, transports)
  const stores = transports.get(transport) ?? new Map<string, StoreV4>()
  transports.set(transport, stores)
  const key = JSON.stringify([registrationContext(r), H.d, r.endpoint])
  const old = stores.get(key)
  if (old) return old
  const store = transport.open(r.endpoint.location.directory.path, H.d, r.endpoint)
  stores.set(key, store)
  if (stores.size > 128) stores.delete(stores.keys().next().value!)
  return store
}
export const openRegisteredRoom = (H: Hub, selector: string, transport: TransportV4): RoomV2 => {
  ensureRoomHomeV5()
  if (transport.layout !== 'git/4') return fail('registered room requires explicit git/4 transport')
  const {state, roomFiles} = hubPorts()
  if (!roomFiles) return fail('registered room location port is not installed')
  const r = roomCatalogue(state).select(parseAddress(selector, 'lookup'), roomFiles)
  if (r.phase !== 'active' || !ownerMatches(r.owner, H.d)) return fail('selected registration belongs to another pinned hub')
  transport.checkLocation(r.endpoint.location.directory.path, H.d, r.endpoint)
  const store = storeFor(H, r, transport)
  store.sync()
  transport.checkLocation(r.endpoint.location.directory.path, H.d, r.endpoint)
  const current = roomCatalogue(state).select(parseAddress(selector, 'lookup'), roomFiles)
  if (JSON.stringify(current) !== JSON.stringify(r)) fail('registration changed while its repository was opened')
  return openedRoomV2(H, r, store)
}
