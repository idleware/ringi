// access: the port a medium's access adapter implements (adapters/access-<type>): the space a hub's rooms live in on
// a forge (or another medium), each room's repository there, and who may write which of its refs; over the network,
// so every call is asynchronous. Trust stays end to end (root, pins, signatures); the medium's rules are defence in
// depth, read back from the medium, never assumed.

// Who may write what in a room's repository: `main` and `chat` by principal, each actor's streams by its principal.
export type Grants = {main: string[], chat: string[], streams: Record<string, string>}
export type AccessAbility = {actorBranches: boolean, privateRepos: boolean, deleteServer: boolean}

export interface Access {
  // The medium's version, the principal its credentials act as (the root's), and what this adapter can enforce there.
  inspect(): Promise<{version: string, principal: string, can: AccessAbility}>
  // A public key on the credentials' own account, so the root pushes as it; there once, whatever the call count.
  ownKey(key: string): Promise<void>
  // The room's repository, found or made private with main and chat for the root and nothing else; its typed address.
  ensureRoom(room: string): Promise<{address: string}>
  // An actor's write access through its own principal: the repository, chat and its exact streams; with `key`, also
  // that public key on the principal's account, if the operator's credentials may put it there. Or its removal.
  grant(room: string, actor: string, principal: string, key?: string): Promise<void>
  revoke(room: string, actor: string, principal: string): Promise<void>
  // The grants the medium enforces now, read from it.
  effective(room: string): Promise<Grants>
  // The served repository gone; a machine's own copy is not the medium's.
  deleteServer(room: string): Promise<void>
}
// An access type by name (an access address's scheme names it): made from the space's locator and the operator's
// local credential reference, never a credential itself.
export type AccessType = (locator: string, authRef: string) => Access
