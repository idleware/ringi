// Root controls use the selected registration and its full lock context; no endpoint/1 paths are consulted.
import {fail, strictJson} from '../../../lib/index.ts'
import {locked} from '../ports/index.ts'
import type {Member, TransportV4} from '../ports/store.ts'
import {compose} from '../protocol/index.ts'
import type {RoomV2} from './index.ts'
import {openRegisteredRoom, registeredRoomLock} from './registered-room.ts'

const currentRoom = (R: RoomV2, transport: TransportV4): RoomV2 => {
  const current = openRegisteredRoom(R.hub, R.endpoint.address, transport)
  if (current.id !== R.id || JSON.stringify(current.context) !== JSON.stringify(R.context) || JSON.stringify(current.endpoint) !== JSON.stringify(R.endpoint)) {
    return fail('registered room identity changed before its control operation; reopen it')
  }
  return current
}
export type RegisteredControl = {who: string, subject: string, mutate: (members: Record<string, Member>) => void, extra?: Array<[string, string]>}
export const registeredControlChange = (R: RoomV2, transport: TransportV4, {who, subject, mutate, extra = []}: RegisteredControl): RoomV2 =>
  locked(registeredRoomLock(R) + '-control', () => {
    const current = currentRoom(R, transport)
    const members = Object.fromEntries(Object.entries(current.members).map(([actor, member]) => [actor, {...member}]))
    mutate(members)
    if (current.hub.signed && JSON.stringify(members) !== JSON.stringify(current.members)) fail('in a signed room, membership changes only by explicit key admission or removal')
    // Read only an accepted control. The backend validates the complete transition before moving the ref.
    const text = current.store.controlFile(current.s, 'members.json', current.head) ?? fail('accepted control has no members.json')
    const envelope = strictJson<{members: Record<string, Member>, retired: Record<string, unknown>}>(text, 'members.json')
    current.store.updateControl(current.s, who, compose(subject, [['To', '*'], ['Kind', 'room'], ...extra]), {
      'members.json': JSON.stringify({...envelope, members}, null, 2) + '\n',
    })
    // Reopen through the same physical and catalogue checks, with the newly accepted control and membership.
    return currentRoom(R, transport)
  })
