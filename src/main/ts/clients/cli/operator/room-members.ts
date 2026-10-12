// room-members: `ringi room admit | remove`.

import * as Rooms from '../../../core/hub/usecases/rooms.ts'
import type {Hub} from '../../../core/hub/rooms/index.ts'
import {fail} from '../../../lib/index.ts'
import type {Opts} from '../args.ts'
import {opt, out} from '../args.ts'

export const admitRoom = (H: Hub, arg: string | undefined, o: Opts) => {
  const R = Rooms.roomIn(H, opt(o, 'room'))
  Rooms.admit(H, R, arg ?? fail('usage: ringi room admit <agent> <public key|file>'), o._[2] ?? fail('usage: ringi room admit <agent> <public key|file>'))
  return out(`admitted ${arg} to ${H.name}/${R.name}: its signed messages are accepted from now on; it can join`)
}

export const removeRoom = (H: Hub, arg: string | undefined, o: Opts) => {
  const R = Rooms.roomIn(H, opt(o, 'room'))
  Rooms.remove(H, R, arg ?? fail('usage: ringi room remove <agent>'))
  return out(`removed ${arg} from ${R.name}: it can no longer write or be woken there; returning needs a fresh join`)
}
