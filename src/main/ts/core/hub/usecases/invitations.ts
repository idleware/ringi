// invitations (E8, not yet wired): the root's own list of whom it invited into a room in a space, kept on its machine
// beside the room's endpoint and never published. It routes and guards the root's invite, admit and remove; who is
// retired is the verified controls' to say, and where the two disagree, the controls win and the command refuses.

import {fail} from '../../../lib/index.ts'
import {hubPorts} from '../ports/index.ts'
import {registrationKey} from '../rooms/room-catalogue.ts'
import type {RoomRegistrationId} from '../rooms/room-catalogue.ts'

export type InvitationMode = 'account' | 'deploy-key'
export type InvitationState = 'invited' | 'admitted' | 'removed'
export type Invitation = {
  invitation: string
  mode: InvitationMode
  // The canonical realm (provider, API host and port) and the account on it, or the label of a deploy key.
  realm: string
  principal: {id: string | null, login: string} | {label: string}
  // The actor the root assigned: the account's login first, the next unused one for an account that returns.
  actor: string
  state: InvitationState
  address: string
  genesis: string | null
  // The control record that removed the actor, once removed, and whether the medium's rights are taken back yet.
  removal?: {control: string, medium: 'pending' | 'done'}
  // In deploy-key mode, the deploy key the medium keeps for the actor, by its record.
  deployKey?: {record: string, key: string}
}
export type Invitations = {schema: 'ringi-invitations/1', entries: Invitation[]}
// Beside the room's registration in the machine's catalogue, under its opaque id.
export const invitationsKey = (id: RoomRegistrationId) => [...registrationKey(id), 'invitations']
const EMPTY: Invitations = {schema: 'ringi-invitations/1', entries: []}
export const loadInvitations = (id: RoomRegistrationId): Invitations => {
  const list = hubPorts().state.read<Invitations>(invitationsKey(id), EMPTY)
  return list.schema === 'ringi-invitations/1' && Array.isArray(list.entries) ? list : fail(`the invitations of room ${id.slice(0, 12)} are not ones this ringi reads`)
}
// The list with one entry changed by `change`, written back; the entry is found by its actor, never by a login.
export const updateInvitation = (id: RoomRegistrationId, actor: string, change: (e: Invitation) => Invitation): Invitation => {
  const list = loadInvitations(id), at = list.entries.findIndex(e => e.actor === actor)
  if (at === -1) fail(`${actor} was never invited into this room`)
  const next = change(list.entries[at])
  hubPorts().state.write(invitationsKey(id), {...list, entries: list.entries.map((e, i) => i === at ? next : e)})
  return next
}
export const addInvitation = (id: RoomRegistrationId, entry: Invitation): void => {
  const list = loadInvitations(id)
  const why = inviteRefusal(list.entries, entry) ?? (list.entries.some(e => e.actor === entry.actor) ? `${entry.actor} was an actor of this room already` : null)
  if (why) fail(why)
  hubPorts().state.write(invitationsKey(id), {...list, entries: [...list.entries, entry]})
}

// --- the list's rules (pure) ---

const ACTIVE: InvitationState[] = ['invited', 'admitted']
const RESERVED = new Set(['operator', 'main', 'chat'])
// The same invitee: one account on one realm (by its stable id where the medium has one), or one label.
const same = (a: Invitation, b: Pick<Invitation, 'realm' | 'principal'>): boolean => {
  if (a.realm !== b.realm) return false
  const [p, q] = [a.principal, b.principal]
  if ('label' in p || 'label' in q) return 'label' in p && 'label' in q && p.label === q.label
  return p.id !== null && q.id !== null ? p.id === q.id : p.login.toLowerCase() === q.login.toLowerCase()
}
const nameOf = (p: Invitation['principal']) => ('label' in p ? p.label : p.login).toLowerCase()
// The actor id for a new invitee: its login or label if no actor of the room ever had it, else the first `<it>-<n>`
// none had. `taken` is every actor id the room ever knew: its members, its retired, every invitation.
export const nextActor = (principal: Invitation['principal'], taken: Set<string>, valid: (id: string) => boolean): string => {
  const base = nameOf(principal)
  if (!valid(base) || RESERVED.has(base)) fail(`${base} cannot name an actor: lowercase letters, digits, - and _; not ${[...RESERVED].join(', ')}`)
  for (let n = 1; ; n++) {
    const id = n === 1 ? base : `${base}-${n}`
    if (!valid(id)) fail(`no actor id is left for ${base}`)
    if (!taken.has(id)) return id
  }
}
// Why this invitee cannot be invited now: it is invited or admitted already, or its removal is not finished.
export const inviteRefusal = (list: Invitation[], who: Pick<Invitation, 'realm' | 'principal'>): string | null => {
  const mine = list.filter(e => same(e, who))
  if (mine.some(e => ACTIVE.includes(e.state))) return `${nameOf(who.principal)} is invited or admitted in this room already`
  if (mine.some(e => e.state === 'removed' && e.removal?.medium !== 'done')) return `${nameOf(who.principal)}'s removal is not finished; finish it first (room remove again)`
  return null
}
// Why a retry of this actor's removal must stop before any destructive write: the same invitee is active again
// under a newer actor, whose rights on the medium are the same account's.
export const staleRemoval = (list: Invitation[], actor: string): string | null => {
  const old = list.find(e => e.actor === actor)
  const newer = old && list.find(e => e.actor !== actor && same(e, old) && ACTIVE.includes(e.state))
  return newer ? `${actor}'s removal is stale: ${newer.actor} holds the same account's rights now; nothing is revoked` : null
}
