// Local endpoint addresses, independent store handles and machine-wide room names.
import path from 'node:path'
import {hubPorts} from '../ports/index.ts'
import {fail} from '../../../lib/index.ts'
import {ID_RE} from '../protocol/index.ts'
import type {RoomEndpoint, Store} from '../ports/store.ts'
import {hubNames} from './hubs.ts'
import {storeOf, transportOf} from './address.ts'
import type {Hub} from './index.ts'
export const endpointKey = (H: Hub, name: string) => ['hub', H.name, 'rooms', name, 'endpoint']
export const roomDir = (H: Hub, name: string): string => path.join(H.dir, 'rooms', name)
export const transportFor = (H: Hub, e: RoomEndpoint) => transportOf(H.name, e.store.remote ? storeOf(e.store.remote).type : H.d.store.type)
export const roomLock = (H: Hub, name: string): string => ID_RE.test(name) ? `room-${H.d.genesis}-${name}` : fail(`bad room name ${name}`)
export const uniqueName = (H: Hub, name: string): void => {
  for (const hub of hubNames()) if (hub !== H.name && hubPorts().state.list(['hub', hub, 'rooms']).includes(name)) fail(`room name ${name} already belongs to hub ${hub}; nothing is replaced`)
}
export const roomNames = (H: Hub): string[] => hubPorts().state.list(['hub', H.name, 'rooms'])
  .filter(name => ID_RE.test(name) && hubPorts().state.read(endpointKey(H, name), null) !== null)
const stores = new Map<string, Store>()
export const selectedStore = (H: Hub, endpoint: RoomEndpoint): Store => {
  const key = JSON.stringify([H.dir, H.d, endpoint])
  const cached = stores.get(key)
  if (cached) return cached
  const store = transportFor(H, endpoint).open(roomDir(H, endpoint.name), H.d, endpoint)
  stores.set(key, store)
  if (stores.size > 128) stores.delete(stores.keys().next().value!)
  return store
}
