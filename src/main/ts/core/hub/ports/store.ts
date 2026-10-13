// store: the port every storage type implements, each an adapter (adapters/store-<type>) that composition/
// registers. Rooms, accepted history, profiles and signals use only this
// interface; git is the first implementation, and a hub's descriptor names which one it uses (`store.type`). A store
// keeps the shared contract (versioned files the participants agree on: contract.json, profiles), the
// rooms (a control record with versioned files, members and roster, and one append-only log per member) and signals
// (append-only actor facts about log entries); the port is split by what each part does (Log, Attachments, …).
// Revisions are opaque, store-assigned ids. A store says whether one revision extends another; ringi builds the
// trust rules on that (core/hub/history).

import type {Entry} from '../protocol/files.ts'

export type Rev = string
export type Member = {role?: string, since?: string}
export type StoredMessage = {id: Rev, parent: Rev | null, time: number, text: Buffer, files: {path: string, mode: string}[], refused: {path: string, mode: string, why?: string}[]}
export type ControlRecord = {rev: Rev, text: string}
export type StoredRoom = {
  name: string
  // The latest control record, the room's first one (its genesis, unique per room), the contract revision the room was
  // created on, and the room's latest entry of any kind.
  head: Rev
  genesis: Rev
  base: Rev
  tip: Rev
  // Control entries, oldest first.
  control: ControlRecord[]
}
// A store that signs (trust `signed`) also verifies rosters and admits keys.
export type Roster = {members: Record<string, Member>, signers: Array<{principal: string}>}
export type JoinKey = {publicKey: string, fingerprint: string, admitted: boolean}

// Every store keeps the shared contract, the rooms with their control records and the members' logs. What it must
// guarantee about them is docs/spec/hub-2.md, What a store guarantees.
export interface Log {
  readonly type: string
  readonly trust: 'asserted' | 'signed'
  isRef(s: string): boolean
  // Bring the local replica up to date and verified (a no-op for a store with no remote).
  sync(): void
  // The shared contract.
  contractHead(): Rev
  contractFile(rev: Rev, name: string): string | null
  amendContract(who: string, text: string, files: Record<string, string | Buffer>): Rev
  // Rooms and their control records.
  roomNames(): string[]
  room(name: string): StoredRoom | null
  // A control file at the head, or at a given control entry (the genesis, say).
  controlFile(room: StoredRoom, name: string, rev?: Rev): string | null
  createRoom(name: string, who: string, text: string, files: Record<string, string>): Rev
  updateControl(room: StoredRoom, who: string, text: string, files: Record<string, string>): Rev
  // The members' logs.
  logIds(room: StoredRoom): string[]
  logHead(room: StoredRoom, id: string): Rev | null
  // Whether `newer` extends `older` (or is it).
  extends(older: Rev, newer: Rev): boolean
  // One member's messages after the room's genesis up to `head`, oldest first.
  messages(room: StoredRoom, id: string, head: Rev): StoredMessage[]
  append(room: StoredRoom, who: string, text: string, entries: Entry[]): Rev
}
// Files stored for explicit message attachments.
export interface Attachments {
  // A file's content stored now, for an attachment that names it later (`Entry.blob`), and its size.
  blob(file: string): {id: Rev, size: number}
  file(rev: Rev, path: string): Buffer
  sizes(rev: Rev, paths: string[]): Map<string, number>
}
// Signals: append-only actor streams (signals-2), bound to a room control and full message revision.
export interface Signals {
  // A logical signal of `who` on `target`; writing the same tuple twice is a no-op.
  signal(room: StoredRoom, who: string, target: Rev, name: string): void
  signals(room: StoredRoom): SignalEvent[]
  signalHeads(room: StoredRoom): SignalHead[]
  pinSignals(room: StoredRoom, reader: string, actor: string, head: Rev): void
}
// What a reader accepted, kept as evidence of what it saw.
export interface Evidence {
  // Keep an accepted revision reachable for a reader; and let it go.
  pin(room: StoredRoom, reader: string, id: string, rev: Rev): void
  unpin(room: StoredRoom, reader: string, id: string): void
}
// Why history may not be accepted. A store whose senders are asserted has nothing to say (null).
export interface Verification {
  // The verified roster of a room; null when members are asserted.
  roster(room: StoredRoom): Roster | null
  // Why a log may not be accepted (signature, roster, transport), or null.
  verifyLog(room: StoredRoom, id: string, head: Rev): string | null
  // What the store skipped while reading the room (commits that are no valid message), as alarms.
  alarms?(room: StoredRoom): string[]
}
// Presence: advisory facts in an actor's telemetry stream; optional.
export interface Presence {
  heartbeat(room: StoredRoom, who: string, target: Rev, text: string): Rev
  heartbeats(room: StoredRoom): Array<{agent: string, target: Rev, time: number, text: string}>
}
// A signed store: its root, members' keys, and a transport alarm the operator forgets after review.
export interface Signed {
  admit(room: StoredRoom, who: string, key: string): Rev
  joinKey(room: StoredRoom, who: string): JoinKey
  forgetLog(room: StoredRoom, id: string): void
  // The signers file a new signed room starts with: the root alone.
  rootRoster(): string
}
// A store: the log with its attachments, signals, evidence and verification; presence and signing
// where it has them.
export interface Store extends Log, Attachments, Signals, Evidence, Verification, Partial<Presence>, Partial<Signed> {}

// A hub's descriptor: what this machine knows about a hub before reading anything from its store.
export type Descriptor = {
  schema: 'ringi-hub/3'
  name: string
  trust: 'asserted' | 'signed'
  // Required for signed trust; checked before opening any store. Asserted trust carries no root.
  root?: string
  genesis: Rev
  store: {type: string}
  // The operator's contract source; an agent needs only its rooms' self-contained repositories.
  contract?: {path: string, remote?: string}
}

export type RoomEndpoint = {
  schema: 'ringi-room/1'
  name: string
  hubGenesis: Rev
  genesis: Rev
  store: {path: string, remote?: string}
  // An opaque local TransportAuth binding, never a credential in the invitation.
  authRef?: string
}

// signals/2: a fact in its actor's append-only stream, causally bound to a verified chat control and message.
export type SignalEvent = {
  id: Rev
  parent: Rev
  roomGenesis: Rev
  control: Rev
  actor: string
  target: Rev
  signal: string
}
export type SignalHead = {actor: string, head: Rev}

// What a new hub's first contract holds, built from its descriptor once the store has pinned its anchors in it.
export type Genesis = (d: Descriptor) => {files: Record<string, string>, text: string}

// A store type, as it makes, opens and replicates hubs on this machine; `at` is a hub's directory, its descriptor beside
// its store. composition/ registers one per type (hub.json names it); a type that is planned refuses with a reason.
export interface Transport {
  // Explicit wire layout; there is no inferred layout or historical fallback.
  readonly layout: string
  // A selected room's store, or the operator's explicit contract source.
  open(at: string, d: Descriptor, endpoint?: RoomEndpoint): Store
  // A new hub's store. A signed one makes its root key first and pins it in `d` (root, then genesis); `custody` says where
  // the new root key is kept, to tell the operator.
  create(at: string, d: Descriptor, genesis: Genesis): {store: Store, custody: string | null}
  // Copy only the source contract into a fresh room repository, without copying other rooms or refs.
  fork(at: string, d: Descriptor, source: Store, endpoint: RoomEndpoint): Store
  // A fresh local replica at the explicit endpoint; verification precedes installation.
  attachRoom(at: string, d: Descriptor, endpoint: RoomEndpoint): Store
}
