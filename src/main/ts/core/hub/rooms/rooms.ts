// rooms: a room opened with its contract, profile, members and quorum; and the root's control changes.

import {DEFAULT_PROFILE} from '../work/index.ts'
import {hubPorts, locked} from '../ports/index.ts'
import {fail, strictJson} from '../../../lib/index.ts'
import {compose} from '../protocol/index.ts'
import type {Member, RoomEndpoint} from '../ports/store.ts'
import {openContract, readProfileResource} from './hubs.ts'
import {endpointRefusal} from './compat.ts'
import {ID_RE} from '../protocol/index.ts'
import type {Hub, Room} from './index.ts'
import {endpointKey, roomLock, roomNames, selectedStore} from './room-catalogue.ts'
import {openedRoom} from './room-view.ts'
export {roomNames} from './room-catalogue.ts'
export {createRoom, attachRoom, deleteRoom} from './room-life.ts'

const missing = (H: Hub, name: string, quiet: boolean): null =>
  quiet ? null : fail(`no room ${name} in hub ${H.name}; rooms: ${roomNames(H).join(', ') || 'none'}`)
export const openRoom = (H: Hub, name: string | null | undefined, {quiet = false, refresh = false}: {quiet?: boolean, refresh?: boolean} = {}): Room | null => {
  if (!name) return fail('no room: the operator creates one with ringi room create <id>, or picks one with ringi room switch <id>')
  if (!ID_RE.test(name)) fail(`bad room name ${name}`)
  const endpoint = hubPorts().state.read<RoomEndpoint | null>(endpointKey(H, name), null)
  if (!endpoint) return missing(H, name, quiet)
  const why = endpointRefusal(H.d, name, endpoint)
  if (why) fail(why)
  const store = selectedStore(H, endpoint)
  void refresh
  store.sync()
  return openedRoom(H, endpoint, store)
}
export const room = (H: Hub, name: string | null | undefined): Room => openRoom(H, name)!
export const ROOM_MD = (name: string): string => `# room ${name}\n\nA ringi room: members.json lists who takes part; profile.json is what a piece of work is here, fixed when the room was made.\n`
export const profileText = (H: Hub, name: string): string | null =>
  (() => { const {store, main} = openContract(H); return store.contractFile(main, `profiles/${name}.json`) ?? (name === DEFAULT_PROFILE ? readProfileResource(DEFAULT_PROFILE) : null) })()
// A control change under the hub lock. In a signed room membership changes only through `room admit`.
export const controlChange = (R: Room, who: string, subject: string, mutate: (m: Record<string, Member>) => void, extra: Array<[string, string]> = []): void =>
  locked(roomLock(R.hub, R.name), () => {
    const s = R.store.room(R.name) ?? fail(`room ${R.name} is gone`)
    const members = strictJson<Record<string, Member>>(R.store.controlFile(s, 'members.json') ?? '{}', `room ${R.name}: members.json`)
    const before = JSON.stringify(members)
    mutate(members)
    if (R.hub.signed && JSON.stringify(members) !== before) fail('in a signed room, membership changes only by ringi room admit')
    R.head = R.store.updateControl(s, who, compose(subject, [['To', '*'], ['Kind', 'room'], ...extra]), {'members.json': JSON.stringify(members, null, 2) + '\n'})
    R.members = members
  })
