// store: the port every storage type implements, and the types this ringi knows (one directory each: git, kafka,
// temporal). Rooms, accepted history, profiles, decisions and signals use only
// this interface; git is the first implementation (git-store.ts), and a hub's descriptor names which one it uses
// (`store.type`). A store keeps three things:
//   - the shared contract: versioned files the participants agree on (contract.json, authority.json, profiles);
//   - rooms: a control record with versioned files (members, roster), and one append-only log per member;
//   - signals: named markers that point at log entries.
// Revisions are opaque, store-assigned ids. A store says whether one revision extends another; ringi builds the
// trust rules on that (hub.ts).

import type {Entry} from '../protocol/files.ts'
import {GitStore} from './git/index.ts'
import {kafka} from './kafka/index.ts'
import {temporal} from './temporal/index.ts'

export type Rev = string
export type Member = {role?: string, since?: string}
export type StoredMessage = {id: Rev, parent: Rev | null, time: number, text: Buffer, files: {path: string, mode: string}[], refused: {path: string, mode: string, why?: string}[]}
export type ControlRecord = {rev: Rev, text: string}
export type StoredRoom = {
  name: string
  archived: boolean
  // The latest control record, the room's first one (its genesis, unique per room), the contract revision the room was
  // created on, and the room's latest entry of any kind.
  head: Rev
  genesis: Rev
  base: Rev
  tip: Rev
  // Control entries, oldest first.
  control: ControlRecord[]
}
// A signal as stored: its name `<message>.<signal>` in its actor's namespace, the stored object (for pinning) and the
// message it points at.
export type SignalRecord = {ref: string, object: Rev, name: string, actor: string, target: Rev, tagger: string, text: string}
// A store that signs (trust `signed`) also verifies rosters and admits keys.
export type Roster = {members: Record<string, Member>, signers: Array<{principal: string}>}
export type JoinKey = {publicKey: string, fingerprint: string, admitted: boolean}

export interface Store {
  readonly type: string
  readonly trust: 'asserted' | 'signed'
  isRef(s: string): boolean
  // Bring the local replica up to date and verified (a no-op for a store with no remote).
  sync(): void
  // --- the shared contract ---
  contractHead(): Rev
  contractFile(rev: Rev, name: string): string | null
  contractFiles(rev: Rev): string[]
  amendContract(who: string, text: string, files: Record<string, string | Buffer>): Rev
  // --- rooms ---
  roomNames(archived: boolean): string[]
  room(name: string): StoredRoom | null
  // A control file at the head, or at a given control entry (the genesis, say).
  controlFile(room: StoredRoom, name: string, rev?: Rev): string | null
  createRoom(name: string, who: string, text: string, files: Record<string, string>): Rev
  updateControl(room: StoredRoom, who: string, text: string, files: Record<string, string>): Rev
  archiveRoom(room: StoredRoom, as: string): void
  // The room and everything the store keeps for it.
  deleteRoom(room: StoredRoom): void
  // An explicit, history-preserving transition from an older store layout, if supported.
  migrateRoom?(name: string): Rev
  // A signed store's verified roster of a room; null for a store whose members are asserted.
  roster(room: StoredRoom): Roster | null
  // --- logs ---
  logIds(room: StoredRoom): string[]
  logHead(room: StoredRoom, id: string): Rev | null
  // Whether `newer` extends `older` (or is it).
  extends(older: Rev, newer: Rev): boolean
  // One member's messages after the room's genesis up to `head`, oldest first.
  messages(room: StoredRoom, id: string, head: Rev): StoredMessage[]
  append(room: StoredRoom, who: string, text: string, entries: Entry[]): Rev
  // What the store skipped while reading the room (a signed hub: commits that are no valid message), as alarms.
  alarms?(room: StoredRoom): string[]
  // Why a log may not be accepted (signature, roster, transport), or null.
  verifyLog(room: StoredRoom, id: string, head: Rev): string | null
  // Keep an accepted revision reachable for a reader, as evidence; and let it go.
  pin(room: StoredRoom, reader: string, id: string, rev: Rev): void
  unpin(room: StoredRoom, reader: string, id: string): void
  file(rev: Rev, path: string): Buffer
  sizes(rev: Rev, paths: string[]): Map<string, number>
  // --- signals ---
  // A signal `<signal>.<message12>` of `who` on the message `target`; writing it twice is a no-op.
  signal(room: StoredRoom, who: string, target: Rev, name: string): void
  signals(room: StoredRoom): SignalRecord[]
  // --- signed stores only ---
  admit?(room: StoredRoom, who: string, key: string): Rev
  joinKey?(room: StoredRoom, who: string): JoinKey
  forgetLog?(room: StoredRoom, id: string): void
  rootKey?(): string
  // The signers file a new signed room starts with: the root alone.
  rootRoster?(): string
}

// A hub's descriptor: what this machine knows about a hub before reading anything from its store.
export type Descriptor = {
  schema: 'ringi-hub/2'
  name: string
  trust: 'asserted' | 'signed'
  // Pins given by the operator out of band; a signed store checks what it fetches against them.
  root?: string
  genesis?: string
  store: {type: string, path: string, remote?: string}
}
export type StoreFactory = (dir: string, d: Descriptor, home: string) => Store

// The store types this ringi knows. Another type is a directory here implementing Store, and an entry below.
export const STORES: Record<string, StoreFactory> = {git: (dir, d, home) => new GitStore(dir, d, home), kafka, temporal}
