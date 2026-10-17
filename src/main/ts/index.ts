// The library: the message protocol, profiles, signals and the Store port, for programs that coordinate
// through ringi without its command line (a framework's own runner, another store, another client).
// Importing it wires this machine's defaults (composition/); a program that brings its own adapters calls wire().
import './composition/index.ts'

export * from './core/hub/protocol/index.ts'
export * from './core/hub/work/index.ts'
export * as signals from './core/hub/signals/index.ts'
export type {Store, Transport, Descriptor, RoomEndpoint, RoomEndpointV2, StoredRoom, StoredMessage, SignalEvent, SignalHead, Rev} from './core/hub/ports/store.ts'
export {openHub, contractAt} from './core/hub/rooms/index.ts'
// A room by its address, or the one known room of a name.
export {roomNamed as openRoom} from './core/hub/usecases/rooms.ts'
export type {Hub, Room, RoomV2, Contract} from './core/hub/rooms/index.ts'
