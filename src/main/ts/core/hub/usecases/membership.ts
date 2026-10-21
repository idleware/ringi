// membership: inviting an account into a room in a space, admitting the actor it was given, and removing one, in the
// order the contract fixes. A read-only check refuses before any write; then the root-signed record; then the host's
// grant, or its taking back; then a readback. The root's own list routes and guards each step; who is retired is the
// verified records' to say (hub-2, Rooms in a space).

import crypto from 'node:crypto'
import {fail} from '../../../lib/index.ts'
import {AGENT_RE} from '../protocol/index.ts'
import {locked} from '../ports/index.ts'
import type {Access} from '../ports/access.ts'
import {OPERATOR, registeredMetadataChange, registeredRoomLock} from '../rooms/index.ts'
import type {RoomV2} from '../rooms/index.ts'
import {accessOf, grantInSpace} from './access.ts'
import {agentId} from './roster.ts'
import {addInvitation, loadInvitations, nextActor, staleRemoval, updateInvitation} from './invitations.ts'
import type {Invitation, InvitationMode} from './invitations.ts'

const space = (R: RoomV2): Access => accessOf(R.hub) ?? fail(`room ${R.endpoint.address} is in no space; agents on this machine join it by name`)
const loginOf = (e: Invitation) => 'label' in e.principal ? fail(`${e.actor} came with a deploy key, not an account`) : e.principal.login
const keyLine = (key: string) => key.trim().split(/\s+/).slice(0, 2).join(' ')
// The root's list of this room, as it is now: a list left by a room deleted at the same address is not this one's.
const listed = (R: RoomV2, actor: string, change: (e: Invitation) => Invitation) => registeredMetadataChange(R, () => updateInvitation(R.id, actor, change))
// The room as this machine has it now, and the root's entry for this very room: a view of a room deleted and made
// again at its address writes nothing, here or on the host. Checked before each write, after every wait.
const current = (R: RoomV2, e?: Invitation): void => registeredMetadataChange(R, () => {
  if (e && (e.address !== R.endpoint.address || e.genesis !== R.genesis)) fail(`${e.actor}'s invitation is of another room at ${e.address}`)
})
// The root's control writes of one room, one at a time on this machine.
const control = <T>(R: RoomV2, e: Invitation, fn: () => T): T => { current(R, e); return locked(`${registeredRoomLock(R)}-control`, fn) }

// An invitation planned before its room exists: the canonical account or the deploy key's label, the actor the root
// gives it and a fixed id, so a create run again plans the same and finishes what it did not. A name that cannot be an
// actor refuses here, before anything is made.
export type Planned = {mode: InvitationMode, principal: Invitation['principal'], actor: string, invitation: string}
const nameOf = (p: Invitation['principal']) => 'label' in p ? p.label : p.login
const principalOf = async (access: Access, mode: InvitationMode, realm: string, who: string): Promise<Invitation['principal']> => {
  if (mode === 'deploy-key') return {label: who}
  const a = await access.account?.(who) ?? fail(`no account ${who} in ${realm}`)
  return {id: a.id, login: a.login}
}
export const planInvites = async (access: Access, mode: InvitationMode, realm: string, address: string, names: string[]): Promise<Planned[]> => {
  const plan: Planned[] = [], taken = new Set<string>()
  for (const who of names) {
    const principal = await principalOf(access, mode, realm, who), name = nameOf(principal)
    if (plan.some(p => nameOf(p.principal).toLowerCase() === name.toLowerCase())) continue
    const actor = nextActor(principal, taken, x => AGENT_RE.test(x))
    taken.add(actor)
    plan.push({mode, principal, actor, invitation: crypto.createHash('sha256').update(`${address}\0${name}`).digest('hex').slice(0, 16)})
  }
  return plan
}
// The planned invitations, in the root's list: those it holds already as they are, the others added.
export const invitePlanned = (R: RoomV2, realm: string, plan: Planned[]): Invitation[] => registeredMetadataChange(R, () => plan.map(p => {
  const had = loadInvitations(R.id).entries.find(e => e.invitation === p.invitation)
  if (had) return had
  const entry: Invitation = {invitation: p.invitation, mode: p.mode, realm, principal: p.principal, actor: p.actor, state: 'invited', address: R.endpoint.address, genesis: R.genesis}
  addInvitation(R.id, entry)
  return entry
}))
// Whether the root's list holds every planned invitation.
export const allInvited = (id: Parameters<typeof loadInvitations>[0], plan: Planned[]): boolean => {
  const have = new Set(loadInvitations(id).entries.map(e => e.invitation))
  return plan.every(p => have.has(p.invitation))
}

// A new invitee's entry: its canonical account (or label), the actor id no actor of the room ever had, a fresh id.
export const inviteInto = async (R: RoomV2, {mode, realm, who, invitation}: {mode: InvitationMode, realm: string, who: string, invitation: string}): Promise<Invitation> => {
  const access = space(R)
  const principal = mode === 'deploy-key' ? {label: who} : await access.account?.(who) ?? fail(`no account ${who} in ${realm}`)
  current(R)
  const retired = Object.keys(R.store.retirements?.(R.s) ?? {})
  const taken = new Set([...Object.keys(R.members), ...retired, ...loadInvitations(R.id).entries.map(e => e.actor)])
  const entry: Invitation = {invitation, mode, realm, principal, actor: nextActor(principal, taken, x => AGENT_RE.test(x)), state: 'invited', address: R.endpoint.address, genesis: R.genesis}
  registeredMetadataChange(R, () => addInvitation(R.id, entry))
  return entry
}
// In account mode the host proves the key: the account's complete key list holds exactly this one.
const proven = async (access: Access, e: Invitation, line: string): Promise<void> => {
  if (e.mode !== 'account' || 'label' in e.principal) return
  const login = e.principal.login, now = await access.account?.(login) ?? fail(`no account ${login} on the forge`)
  if (e.principal.id !== null && now.id !== e.principal.id) fail(`${login} on the forge is not the account invited`)
  const keys = await access.accountKeys?.(now) ?? fail('this forge cannot list an account\'s keys')
  if (!keys.includes(line)) fail(`this key is not on ${login}'s SSH keys on the forge; add it there, then admit again: ${line}`)
}
export const admitInSpace = async (R: RoomV2, actor: string, key: string): Promise<Invitation> => {
  const access = space(R), line = keyLine(key), name = R.endpoint.address
  const e = loadInvitations(R.id).entries.find(x => x.actor === actor) ?? fail(`${actor} was never invited into ${name}`)
  if (e.state === 'removed') fail(`${actor} was removed from ${name}; invite the account again, as a new actor`)
  current(R, e)
  await proven(access, e, line)
  agentId(actor)
  control(R, e, () => R.store.admit?.(R.s, actor, line) ?? fail(`room ${name}: its store cannot admit keys`))
  current(R, e)
  if (e.mode === 'account') await grantInSpace(R, access, actor, loginOf(e))
  const deployKey = e.mode === 'deploy-key' ? e.deployKey ?? await deployed(access, R, e, line) : undefined
  return listed(R, actor, x => ({...x, state: 'admitted', ...(deployKey ? {deployKey} : {})}))
}
const deployed = async (access: Access, R: RoomV2, e: Invitation, line: string) => {
  const k = await access.deployKey?.(R.name, e.actor, line) ?? fail('this forge keeps no deploy keys')
  if (!(await access.deployKeys?.(R.name) ?? []).some(x => x.record === k.record && x.key === line)) fail(`the deploy key for ${e.actor} is not on ${R.name} after adding it`)
  return {record: k.record, key: line}
}
export const removeFromSpace = async (R: RoomV2, actor: string): Promise<Invitation> => {
  const list = loadInvitations(R.id).entries, name = R.endpoint.address
  const e = list.find(x => x.actor === actor) ?? fail(`${actor} was never invited into ${name}`)
  const stale = staleRemoval(list, actor)
  if (stale) fail(stale)
  const removal = control(R, e, () => R.store.remove?.(R.s, OPERATOR, actor)) ?? fail(`room ${name} cannot remove a member`)
  listed(R, actor, x => ({...x, state: 'removed', removal: {control: removal, medium: x.removal?.medium ?? 'pending'}}))
  const access = space(R)
  current(R, e)
  if (e.mode === 'account') await access.revoke(R.name, actor, loginOf(e))
  else if (e.deployKey) await access.dropDeployKey?.(R.name, e.deployKey.record)
  return listed(R, actor, x => ({...x, removal: {control: removal, medium: 'done'}}))
}
// A member of a local room removed: its record, and nothing on a medium.
export const removeLocal = (R: RoomV2, actor: string): void => {
  if (!R.members[actor]) fail(`${actor} is not a member of ${R.endpoint.address}`)
  current(R)
  locked(`${registeredRoomLock(R)}-control`, () => R.store.remove?.(R.s, OPERATOR, actor) ?? fail(`room ${R.endpoint.address} cannot remove a member`))
}
