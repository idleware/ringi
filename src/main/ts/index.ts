// The library: the message protocol, profiles, decisions, signals and the Store port, for programs that coordinate
// through ringi without its command line (a framework's own runner, another store, another client).
export * from './protocol/index.ts'
export * from './domain/profiles.ts'
export * as decide from './domain/decisions.ts'
export * as signals from './domain/signals.ts'
export type {Store, StoreFactory, Descriptor, StoredRoom, StoredMessage, SignalRecord, Rev} from './store/index.ts'
export {STORES} from './store/index.ts'
export {openHub, openRoom, createHub, contractAt} from './hub/index.ts'
export type {Hub, Room, Contract} from './hub/index.ts'
