// E8 location seam, not yet wired: repository files are separate from the machine's LocalState.
import type {Rev} from './store.ts'

// A canonical directory and an opaque filesystem object identity; equal paths alone prove no continuity.
export type RoomDirectory = {path: string, identity: string}
export type RoomLocation = {directory: RoomDirectory, generation: string}
// Only a completed creation gets a receipt. Joining a repository does not establish local ownership.
export type RoomReceipt = {reservation: string, address: string, genesis: Rev, directory: RoomDirectory}
export type RoomDisposal = {phase: 'prepared' | 'repository-removed', receipt: RoomReceipt}
// Local allocation and quarantine prove filesystem ownership only, never creation of accepted history.
export type RoomQuarantine = {source: RoomDirectory, home: RoomDirectory, parent: RoomDirectory, trash: RoomDirectory, destination: string}

export interface RoomFiles {
  // Resolve an existing directory; null only when missing, never for unreadable or malformed locations.
  canonical(path: string): RoomDirectory | null
  // Resolve an existing parent and create only its final leaf exclusively; protect the home and its ancestors.
  createLeaf(path: string, home: string): RoomDirectory
  // Revalidate the selected canonical object. A caller resolves an alias again and compares its identity first.
  check(directory: RoomDirectory): void
  // Receipt-bound contained disposal, with no symlink traversal or parent removal. Refuse when the platform
  // cannot guarantee containment or when the selected repository contains unowned files.
  purge(receipt: RoomReceipt, home: string): void
  planQuarantine?(directory: RoomDirectory, home: string): RoomQuarantine
  quarantine?(plan: RoomQuarantine, home: string): RoomDirectory
}
