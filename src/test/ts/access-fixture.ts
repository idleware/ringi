// Unit callers keep the provider receipt as the real catalogue does, without granting a name ownership by itself.
import assert from 'node:assert/strict'
import type {Access, RoomProvision} from '../../main/ts/core/hub/ports/access.ts'

export const fixtureAccess = (access: Access) => {
  const ids = new Map<string, string>()
  const provision = (room: string): RoomProvision => ({repositoryId: ids.get(room),
    bind: result => {ids.set(room, result.repositoryId)}, checkChat: () => assert.fail('fixture has no pinned chat')})
  return {...access, ensureRoom: (room: string, intent = provision(room)) => access.ensureRoom(room, intent),
    deleteServer: (room: string, id = ids.get(room) ?? '') => access.deleteServer(room, id)}
}
