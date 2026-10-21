// access: the space a room lives in on a forge (`forgejo://forge.example/team`): the hub this machine keeps for it,
// made with the space's first room, and the access adapter the address's provider names, with the operator's local
// token file. A local room has neither.

import crypto from 'node:crypto'
import fs from 'node:fs'
import {fail} from '../../../lib/index.ts'
import {hubPorts} from '../ports/index.ts'
import type {Access} from '../ports/access.ts'
import {canonical, parseAddress} from '../rooms/address.ts'
import type {RemoteSpace} from '../rooms/address.ts'
import {createHub, hubNames, openHub} from '../rooms/index.ts'
import type {Hub, RoomV2} from '../rooms/index.ts'

const make = (space: string, authRef: string): Access => {
  const a = parseAddress(space, 'create')
  if (a.kind !== 'space') return fail(`${space} is not a space`)
  const known = hubPorts().access ?? {}
  return (known[a.provider] ?? fail(`ringi makes no rooms on ${a.provider} yet; it knows ${Object.keys(known).join(', ') || 'none'}`))(space, authRef)
}
export const accessOf = (H: Hub): Access | null => H.d.access ? make(H.d.access.address, H.d.access.authRef) : null

// The space of a room address, canonical; and the realm its accounts live in: the provider with its host and port.
export const spaceOf = (a: Pick<RemoteSpace, 'provider' | 'host' | 'port' | 'space'>): string =>
  canonical({kind: 'space', provider: a.provider, host: a.host, port: a.port, space: a.space})
export const realmOf = (space: string): string => space.slice(0, space.lastIndexOf('/'))
// One hub per space, named by its address, so a space is known once on this machine whatever its rooms.
const hubName = (space: string) => `space-${crypto.createHash('sha256').update(space).digest('hex').slice(0, 16)}`
const pins = (file: string): string[] => {
  const keys = fs.readFileSync(file, 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
  return keys.length ? keys : fail(`${file} holds no host key`)
}
export type SpaceMode = 'account' | 'deploy-key'
export type SpaceInput = {tokenFile?: string, hostKeyFile?: string, mode?: SpaceMode}
// A space this machine knows keeps its token file and the host's keys: a room made later names none, or the same.
const known = (H: Hub, space: string, {tokenFile, hostKeyFile, mode}: SpaceInput): Hub => {
  const a = H.d.access ?? fail(`hub ${H.name} keeps no space`)
  if (a.address !== space) fail(`hub ${H.name} keeps ${a.address}, not ${space}`)
  if (tokenFile && fs.realpathSync(tokenFile) !== a.authRef) fail(`${space} is known here with the token in ${a.authRef}; put a new token there`)
  if (hostKeyFile && pins(hostKeyFile).join('\n') !== (a.hostKeys ?? []).join('\n')) fail(`${space} is known here with other host keys; ringi does not change a space's pins`)
  if (mode && mode !== modeOf(H)) fail(`${space} takes its actors in ${modeOf(H)} mode, fixed by its first room`)
  return H
}
// How a space's actors reach their rooms: through their own accounts, or with a write deploy key of each room that the
// root vouches for, where the host cannot keep an account to its own branch (hub-2, Rooms in a space).
export const modeOf = (H: Hub): SpaceMode => H.d.access?.mode ?? 'account'
const chosen = (can: Awaited<ReturnType<Access['inspect']>>['can'], space: string, mode?: SpaceMode): SpaceMode => {
  const m = mode ?? (can.actorBranches && can.accountKeys ? 'account' : 'deploy-key')
  if (m === 'account' && !(can.actorBranches && can.accountKeys)) fail(`${space} cannot keep an account to its own branch; its rooms take deploy keys (--mode deploy-key)`)
  if (m === 'deploy-key' && !can.deployKeys) fail(`${space} keeps no deploy keys; its actors come through their accounts (--mode account)`)
  return m
}
// The host's SSH keys: the operator's, one known_hosts line each; or, where the host serves them over its TLS API and
// the operator gives none, the host's own.
const hostKeysOf = async (access: Access, space: string, file?: string): Promise<string[]> => {
  if (file) return pins(file)
  const can = (await access.inspect()).can
  return can.hostKeysByApi && access.hostKeys ? access.hostKeys()
    : fail(`the first room in ${space} needs --host-key-file: the host's SSH keys as known_hosts lines, which every connection to it pins`)
}
// The space's hub, made with its first room: the token works and says whose it is, the host's keys are pinned, the mode
// is fixed, and the root key, made here, goes on the token's account, so the root pushes as it.
export const spaceHub = async (space: string, x: SpaceInput): Promise<Hub> => {
  const name = hubName(space), had = hubNames().includes(name)
  if (had && openHub(name).d.access) return known(openHub(name), space, x)
  const authRef = fs.realpathSync(x.tokenFile ?? fail(`the first room in ${space} needs --token-file: a file only you read, holding the API token of your account there`))
  const access = make(space, authRef), mode = chosen((await access.inspect()).can, space, x.mode)
  const hostKeys = await hostKeysOf(access, space, x.hostKeyFile)
  // A hub made before its space was written down (an interrupted first room) gets it now.
  if (!had) createHub(name, {signed: true})
  hubPorts().state.write(['hub', name, 'hub'], {...openHub(name).d, access: {address: space, authRef, hostKeys, mode}})
  return openHub(name)
}
// What the root's own account needs before it pushes a room: its key. Again before each room, until it is there.
export const ownKey = async (H: Hub): Promise<void> => {
  await accessOf(H)!.ownKey(H.d.root!).catch((e: Error) => fail(`the root key of ${H.d.access!.address} is not on the forge yet: ${e.message}`))
}
// An actor's access to a room in a space through its own account, after the root admitted its key: granted, then read
// back; what the medium does not enforce is said, never assumed. Which account an actor is lives in the root's
// invitation list (invitations.ts).
export const grantInSpace = async (R: RoomV2, access: Access, actor: string, account: string): Promise<void> => {
  await access.grant(R.name, actor, account)
  const now = await access.effective(R.name)
  if (now.signals[actor] !== account || !now.chat.includes(account)) fail(`${R.name} on the forge does not let ${account} write ${actor}'s signals and the chat; admit again`)
}
// The room's repository on its medium gone; this machine's copy is deleted apart (rooms.erase).
export const deleteServerRoom = async (r: {address: string, name: string, owner: {name: string}}): Promise<void> => {
  const access = accessOf(openHub(r.owner.name)) ?? fail(`room ${r.address} is in no space; delete its repository where it is served`)
  await access.deleteServer(r.name)
}
