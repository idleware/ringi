// state: what ringi keeps on this machine — the operator's terminal context, what each reader accepted, the sessions,
// a hub's descriptor and its store's own files — as a port. A record is named by a key path; the adapter decides where
// it lives (adapters/state-fs: $RINGI_HOME). Reading fails closed: an unreadable record is an error, never a fresh start.

// Each segment is a name: not empty, not `.` or `..`, without a path separator (an adapter refuses anything else).
export type Key = readonly string[]

export interface LocalState {
  // Where the state lives, as the operator would look for it; the turns ringi starts get it too.
  readonly root: string
  // Whether the state exists at all: a removed home ends the processes that serve it (pulse).
  present(): boolean
  // The state is made on first use and migrated; anything else in its place is refused.
  ensure(): void
  // One process of this machine at a time under `name`.
  locked<T>(name: string, fn: () => T): T
  read<T>(key: Key, dflt: T): T
  // Atomic: a reader sees the old record or the new one.
  write(key: Key, value: unknown): void
  // The record and everything under its key.
  remove(key: Key): void
  // The names under a key: its records and the keys below it.
  list(key: Key): string[]
  // A directory for an adapter's own files under the key (a hub's store), made on first use.
  place(key: Key): string
}
