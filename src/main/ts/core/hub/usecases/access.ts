// access: a hub's medium, when its rooms are made in a space on a forge: the adapter its typed address names
// (`forgejo+https://forge/org`), with the operator's local credential reference. None for a hub without one.

import fs from 'node:fs'
import {fail} from '../../../lib/index.ts'
import {hubPorts} from '../ports/index.ts'
import type {Access} from '../ports/access.ts'
import type {Descriptor} from '../ports/store.ts'
import {storeOf} from '../rooms/address.ts'
import type {Hub, Room} from '../rooms/index.ts'
import {endpointKey} from '../rooms/room-catalogue.ts'

const make = (address: string, authRef: string): Access => {
  const {type, locator} = storeOf(address)
  const known = hubPorts().access ?? {}
  return (known[type] ?? fail(`a ${type} space is not one this ringi makes rooms in; it knows ${Object.keys(known).join(', ') || 'none'}`))(locator, authRef)
}
export const accessOf = (H: Hub): Access | null => H.d.access ? make(H.d.access.address, H.d.access.authRef) : null
// An SSH address is reached only with a key bound to it and its host's keys pinned, which a hub on a forge has.
export const overSsh = (address?: string): boolean => !!address && storeOf(address).locator.startsWith('ssh://')
export const NO_MANUAL_SSH = 'an SSH address needs its host\'s pinned keys and a key bound to it, which a hub made with --forge keeps; --url takes git+https:// or git+file://'
export type SpaceInput = {signed: boolean, url?: string, forge?: string, authFile?: string, hostKeyFile?: string}
export type Space = {access: NonNullable<Descriptor['access']>, principal: string, version: string}
// The space a new hub makes its rooms in, if it names one, checked against the medium before the hub is made: the
// credentials work and say whose they are. Host keys come from the operator, one known_hosts line each.
export const spaceFor = async ({signed, url, forge, authFile, hostKeyFile}: SpaceInput): Promise<Space | null> => {
  if (overSsh(url)) fail(NO_MANUAL_SSH)
  if (!forge) return null
  if (!signed) fail('--forge makes the rooms on a forge, for a --signed hub only')
  const authRef = fs.realpathSync(authFile ?? fail('--forge needs --auth-file: a file only you read, holding the API token of your account on the forge'))
  const pins = hostKeyFile ?? fail('--forge needs --host-key-file: the forge\'s SSH host keys as known_hosts lines, which every connection to it pins')
  const hostKeys = fs.readFileSync(pins, 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
  if (!hostKeys.length) fail(`${pins} holds no host key`)
  const {principal, version} = await make(forge, authRef).inspect()
  return {access: {address: forge, authRef, hostKeys}, principal, version}
}
// An actor's access to a room on its medium through its own account, after the root admitted its key: granted, then
// read back; what the medium does not enforce is said, never assumed. The operator's map of actors to accounts is kept
// in the room's endpoint on this machine.
export const grantRoom = async (R: Room, actor: string, principal: string, key?: string): Promise<void> => {
  const access = accessOf(R.hub) ?? fail(`hub ${R.hub.name} makes no rooms on a forge; give ${actor} access to ${R.name}'s repository yourself`)
  await access.grant(R.name, actor, principal, key)
  const now = await access.effective(R.name)
  if (now.streams[actor] !== principal || !now.chat.includes(principal)) fail(`${R.name} on the forge does not let ${principal} write ${actor}'s streams and the chat; run room admit again`)
  hubPorts().state.write(endpointKey(R.hub, R.name), {...R.endpoint, principals: {...R.endpoint.principals, [actor]: principal}})
}
// The room's repository on its medium gone; this machine's copy is deleted apart (rooms.erase).
export const deleteServerRoom = async (R: Room): Promise<void> => {
  const access = accessOf(R.hub) ?? fail(`hub ${R.hub.name} makes no rooms on a forge; delete ${R.name}'s repository where it is served`)
  await access.deleteServer(R.name)
}
