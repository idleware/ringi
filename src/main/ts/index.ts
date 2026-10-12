// The library: the message protocol, profiles, signals and the Store port, for programs that coordinate
// through ringi without its command line (a framework's own runner, another store, another client).
// Importing it wires this machine's defaults (composition/); a program that brings its own adapters calls wire().
import './composition/index.ts'

export * from './core/hub/protocol/index.ts'
export * from './core/hub/work/index.ts'
export * as signals from './core/hub/signals/index.ts'
export type {Store, Transport, Descriptor, StoredRoom, StoredMessage, SignalRecord, Rev} from './core/hub/ports/store.ts'
export {openHub, openRoom, createHub, contractAt} from './core/hub/rooms/index.ts'
export type {Hub, Room, Contract} from './core/hub/rooms/index.ts'
