import * as Rooms from '../../../core/hub/usecases/rooms.ts'
import type {Hub} from '../../../core/hub/rooms/index.ts'
import {fail, short} from '../../../lib/index.ts'
import type {Opts} from '../args.ts'
import {flag, opt, out} from '../args.ts'

export const archiveRoom = (H: Hub, arg: string | undefined, o: Opts) => {
  // Without an id, the room of the current context.
  const R = Rooms.roomIn(H, arg ?? opt(o, 'room'))
  const name = Rooms.archive(H, R)
  return out(`archived ${R.name} as ${name}: read-only, wakes nobody; its sessions end. Read it with --room ${name}`)
}

export const deleteRoom = (H: Hub, arg: string | undefined, o: Opts) => {
  const R = Rooms.roomIn(H, arg ?? opt(o, 'room'))
  if (!flag(o, 'yes')) fail(`deleting ${R.name} in hub ${H.name} erases it and everything kept for it, for good. Run again with --yes, or archive it instead`)
  Rooms.erase(H, R)
  return out(`deleted room ${R.name}: its branch, signals, pins, evidence and readers' state. Sessions bound to it leave it on their next turn`)
}

export const rebaseRoomContract = (H: Hub, arg: string | undefined, o: Opts) => {
  const R = Rooms.roomIn(H, arg ?? fail('usage: ringi room rebase-contract <id>'))
  Rooms.rebase(H, R)
  return out(`room ${R.name} now follows the hub contract at ${short(H.main)} (${H.contract.version})`)
}
