// invitation: joining a room in a space by the line its root made for one account. The machine attaches the room in a
// directory of its own with the key the invitation calls for; until the root admitted that key the join is pending,
// its attachment kept for the retry and nothing registered.

import crypto from 'node:crypto'
import path from 'node:path'
import {hubPorts} from '../../hub/ports/index.ts'
import type {Hub, RoomV2} from '../../hub/rooms/index.ts'
import {adoptHub, adoptRegisteredRoom, roomContextKey} from '../../hub/rooms/index.ts'
import {roomCatalogue, registrationId} from '../../hub/rooms/room-catalogue.ts'
import type {JoinKey, RoomEndpointV2, StoreV4, TransportV4} from '../../hub/ports/store.ts'
import {roomNamed, transportOfHub} from '../../hub/usecases/rooms.ts'
import {keyRefFor} from '../../hub/usecases/invite.ts'
import type {InviteV3} from '../../hub/usecases/invite.ts'
import {fail} from '../../../lib/index.ts'

// Not admitted yet: the key the root admits, and in account mode the account and host it goes on first.
export type Pending = {key: JoinKey, login: string | null, realm: string | null}
export const pendingOf = (x: InviteV3 | null, key: JoinKey): Pending => x && !('label' in x.principal)
  ? {key, login: x.principal.login, realm: x.principal.realm} : {key, login: null, realm: null}
// A join the host refused so far, kept until it succeeds: the same endpoint, directory and key on every retry.
const pendingKey = (x: InviteV3) => ['joins', registrationId(x.address)]
// The endpoint an invitation pins, in a directory of this machine's own: the room's address and history, the root,
// the host's keys, and the key this machine signs and reaches it with.
const endpointOf = (H: Hub, x: InviteV3, identity?: string): RoomEndpointV2 => {
  const st = hubPorts().state, keyRef = keyRefFor(x, identity), old = st.read<RoomEndpointV2 | null>(pendingKey(x), null)
  if (old) return old.genesis === x.genesis && old.hubGenesis === H.d.genesis && old.keyRef === keyRef ? old
    : fail(`another join of ${x.address} waits on this machine, in ${old.location.directory.path}; finish that one`)
  const files = hubPorts().roomFiles ?? fail('this ringi has no room locations wired')
  const directory = files.createLeaf(path.join(st.place(['clones']), registrationId(x.address)), st.root)
  const e: RoomEndpointV2 = {schema: 'ringi-room/2', address: x.address, name: x.room, hubGenesis: H.d.genesis, genesis: x.genesis, trust: 'signed', root: x.root,
    location: {directory, generation: crypto.randomBytes(16).toString('hex')}, store: {path: 'store', remote: x.locator}, keyRef,
    ...(x.locator.startsWith('git+ssh://') ? {authRef: keyRef} : {}), ...(x.hostKeys?.length ? {hostKeys: x.hostKeys} : {})}
  st.write(pendingKey(x), e)
  return e
}
// Whom this machine joined a room in a space as, by which invitation: kept with the room's context once it is joined.
type Joined = {actor: string, invitation: string}
const joinedOf = (R: RoomV2): Joined | null => hubPorts().state.read<Joined | null>(roomContextKey(R, 'joined'), null)
// The actor a room in a space on this machine was joined as, by its invitation; never guessed from a key's name.
export const joinedActor = (R: RoomV2): string => joinedOf(R)?.actor ?? fail(`join ${R.endpoint.address} by the invitation its root made for you`)
// The room this machine joined before, if the invitation is for that same room and actor.
const known = (x: InviteV3): RoomV2 => {
  const R = roomNamed(x.address), was = joinedOf(R)
  if (R.genesis !== x.genesis) fail(`${x.address} on this machine is another room than this invitation's; ask the operator`)
  return !was || was.actor === x.actor ? R : fail(`this machine joined ${x.address} as ${was.actor}; to join it as ${x.actor}, delete that copy first: ringi room delete ${x.address} --yes`)
}
// The store the host lets this key read, or none while it refuses.
const fetched = (transport: TransportV4, H: Hub, e: RoomEndpointV2): StoreV4 | null => {
  try { return transport.attachRoom(e.location.directory.path, H.d, e) } catch (err) {
    if ((err as {code?: string}).code === 'denied') return null
    throw err
  }
}
export const attached = (x: InviteV3, identity?: string): RoomV2 | Pending => {
  if (roomCatalogue(hubPorts().state).all().some(r => r.address === x.address)) return known(x)
  const H = adoptHub({trust: x.trust, root: x.root, genesis: x.hubGenesis}), transport = transportOfHub(H)
  const e = endpointOf(H, x, identity), id = transport.identity!(H.d, x.actor, e)
  const store = fetched(transport, H, e), stored = store?.room(x.room)
  // Reading is not admission: the root's record of this key is.
  if (!stored || !store!.joinKey?.(stored, x.actor).admitted) return pendingOf(x, {...id, admitted: false})
  const R = adoptRegisteredRoom(H, e, transport)
  hubPorts().state.write(roomContextKey(R, 'joined'), {actor: x.actor, invitation: x.invitation})
  hubPorts().state.remove(pendingKey(x))
  return R
}
