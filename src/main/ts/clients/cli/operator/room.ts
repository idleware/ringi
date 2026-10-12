// room: `ringi room <subcommand>`, by its table (room-list, room-members, room-lifecycle).

import * as Hubs from '../../../core/hub/usecases/hubs.ts'
import type {Hub} from '../../../core/hub/rooms/index.ts'
import {fail} from '../../../lib/index.ts'
import type {Opts} from '../args.ts'
import {opt} from '../args.ts'
import {archiveRoom, deleteRoom, rebaseRoomContract} from './room-lifecycle.ts'
import {createRoom, listRoom, switchRoom} from './room-list.ts'
import {admitRoom, removeRoom} from './room-members.ts'

const COMMANDS = new Map<string, (H: Hub, arg: string | undefined, o: Opts) => void>([['list', listRoom], ['create', createRoom], ['switch', switchRoom], ['admit', admitRoom], ['remove', removeRoom], ['archive', archiveRoom], ['delete', deleteRoom], ['rebase-contract', rebaseRoomContract]])
export const roomCmd = (o: Opts) => {
  const [sub, arg] = o._
  const H = Hubs.hubOf(opt(o, 'hub'))
  const run = COMMANDS.get(sub || 'list') ?? fail(`unknown: room ${sub}`)
  run(H, arg, o)
}
