// invite: the one line an agent's machine joins a room by, like a VPN key: the room's address (a URI whose scheme names
// its store: git+ssh://…), which history it must be and the root that signs it. Nothing secret: an address without
// credentials, a public key.

import {fail, strictJson, withoutCredentials} from '../../../lib/index.ts'
import type {Room} from '../rooms/index.ts'

export type Invite = {schema: 'ringi-invite/1', room: string, address: string, genesis: string, hubGenesis: string, trust: 'signed', root: string}
const PREFIX = 'ringi:'
const OID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/

// The invitation to a room published at its endpoint's remote; a room that lives only here has none.
export const invite = (R: Room): string | null => {
  if (!R.hub.signed || !R.endpoint.store.remote || !R.hub.d.root) return null
  const x: Invite = {schema: 'ringi-invite/1', room: R.name, address: withoutCredentials(R.endpoint.store.remote), genesis: R.genesis,
    hubGenesis: R.hub.d.genesis, trust: 'signed', root: R.hub.d.root}
  return PREFIX + Buffer.from(JSON.stringify(x)).toString('base64url')
}
// An invitation carries no credentials: an address with any it refuses rather than keeps.
const valid = (x: Partial<Invite>): boolean => [x.schema === 'ringi-invite/1', x.trust === 'signed',
  ...[x.room, x.address, x.root].map(v => typeof v === 'string'), ...[x.genesis, x.hubGenesis].map(v => OID.test(v ?? '')),
  withoutCredentials(String(x.address)) === x.address].every(Boolean)
// An invitation, if `s` is one; anything else is a room's name.
export const readInvite = (s: string): Invite | null => {
  if (!s.startsWith(PREFIX)) return null
  const x = strictJson<unknown>(Buffer.from(s.slice(PREFIX.length), 'base64url').toString('utf8'), 'the invitation')
  return typeof x === 'object' && x !== null && valid(x) ? x as Invite : fail('this invitation is not one this ringi reads (ringi-invite/1); ask the operator for a new one')
}
