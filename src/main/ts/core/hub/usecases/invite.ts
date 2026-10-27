// invite: the one line an agent's machine joins a room in a space by, like a VPN key: the room's address and the Git
// locator its store reaches, which history it must be, the root that signs it, the pinned keys of the host, and whom
// it routes to. Nothing secret: an address without credentials, public keys. Routing, never proof: the root admits
// only whom its own list names (invitations.ts).

import crypto from 'node:crypto'
import path from 'node:path'
import {fail, strictJson, withoutCredentials} from '../../../lib/index.ts'
import {AGENT_RE} from '../protocol/index.ts'
import type {RoomV2} from '../rooms/index.ts'
import type {Invitation} from './invitations.ts'

export type InviteV3 = {schema: 'ringi-invite/3', mode: 'account' | 'deploy-key', room: string, address: string, locator: string,
  genesis: string, hubGenesis: string, trust: 'signed', root: string, hostKeys?: string[],
  principal: {realm: string, id: string | null, login: string} | {label: string}, actor: string, invitation: string}
const PREFIX = 'ringi:'
// Far above a real line (a root key, a few host keys, an address): what is longer is not one ringi made.
const MAX_LINE = 16384
const OID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/

const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0
const principalOk = (p: unknown): boolean => typeof p === 'object' && p !== null && ('label' in p
  ? str((p as {label: unknown}).label)
  : str((p as {realm?: unknown}).realm) && str((p as {login?: unknown}).login) && ((p as {id?: unknown}).id === null || str((p as {id?: unknown}).id)))
// What an invitation must be: its mode, the room's canonical address and its Git locator without credentials, both
// geneses, the signed root, the host's keys, and whom it routes to; nothing more is trusted from it.
const validV3 = (x: Partial<InviteV3>): boolean => [x.schema === 'ringi-invite/3', x.trust === 'signed',
  x.mode === 'account' || x.mode === 'deploy-key', ...[x.room, x.address, x.locator, x.root, x.invitation].map(str),
  ...[x.genesis, x.hubGenesis].map(v => OID.test(v ?? '')), withoutCredentials(String(x.locator)) === x.locator,
  withoutCredentials(String(x.address)) === x.address, AGENT_RE.test(String(x.actor)), principalOk(x.principal),
  x.hostKeys === undefined || (Array.isArray(x.hostKeys) && x.hostKeys.every(str))].every(Boolean)
export const inviteV3 = (x: Omit<InviteV3, 'schema'>): string => {
  const line: InviteV3 = {schema: 'ringi-invite/3', ...x}
  return validV3(line) ? PREFIX + Buffer.from(JSON.stringify(line)).toString('base64url') : fail(`no invitation can be made for ${x.actor}: a field is missing or carries credentials`)
}
// An invitation, if `s` is one; anything else is a room's address or name. An older invitation is refused by name.
export const readInvite = (s: string): InviteV3 | null => {
  if (!s.startsWith(PREFIX)) return null
  if (s.length > MAX_LINE) fail(`this invitation is longer than any ringi makes (${MAX_LINE} characters); ask the operator for a new one`)
  const x = strictJson<unknown>(Buffer.from(s.slice(PREFIX.length), 'base64url').toString('utf8'), 'the invitation')
  const schema = typeof x === 'object' && x !== null ? (x as {schema?: unknown}).schema : undefined
  if (schema === 'ringi-invite/3') return validV3(x as Partial<InviteV3>) ? x as InviteV3 : fail('this ringi-invite/3 is malformed; ask the operator for a new one')
  return fail(`this invitation is ${typeof schema === 'string' ? schema : 'not one ringi reads'}; this ringi reads ringi-invite/3; ask the operator for a new one`)
}

const opaque = (...parts: string[]) => crypto.createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32)
// The key a joiner signs and reaches with, named for its endpoint (keyRef). An operator's `--identity` file wins.
// In account mode it is this machine's key for the account realm, shared by the realm's rooms, unless the actor is
// not its account's first in the room: a returning actor gets a key of its own, never the retired one. A deploy key
// is the room's own, of this room incarnation.
export const keyRefFor = (x: InviteV3, identity?: string): string => {
  if (identity) return path.isAbsolute(identity) ? `file:${identity}` : fail(`--identity takes an absolute path: ${identity}`)
  const room = `ringi-key:room/${opaque(x.address, x.genesis)}/${x.actor}`
  if ('label' in x.principal) return room
  return x.actor === x.principal.login.toLowerCase() ? `ringi-key:realm/${opaque(x.principal.realm)}/${x.principal.login.toLowerCase()}` : room
}
// The line for one invitee of the root's list: the room as this machine pinned it, and the entry it routes to.
// A public key's fingerprint as OpenSSH prints it, for the operator to compare on both machines: a key carried through
// a channel someone else holds may not be the one sent.
export const fingerprintOf = (line: string): string =>
  'SHA256:' + crypto.createHash('sha256').update(Buffer.from(line.trim().split(/\s+/)[1] ?? '', 'base64')).digest('base64').replace(/=+$/, '')
export const inviteLine = (R: RoomV2, e: Invitation): string => inviteV3({mode: e.mode, room: R.name, address: R.endpoint.address,
  locator: withoutCredentials(R.endpoint.store.remote ?? fail(`room ${R.endpoint.address} is published nowhere`)), genesis: R.genesis,
  hubGenesis: R.hub.d.genesis, trust: 'signed', root: R.hub.d.root ?? fail(`room ${R.endpoint.address} has no signed root`),
  ...(R.endpoint.hostKeys?.length ? {hostKeys: R.endpoint.hostKeys} : {}),
  principal: 'label' in e.principal ? {label: e.principal.label} : {realm: e.realm, id: e.principal.id, login: e.principal.login},
  actor: e.actor, invitation: e.invitation})
