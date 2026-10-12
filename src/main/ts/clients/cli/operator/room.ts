// room: `ringi room list | create | switch | admit | remove | delete | rebase-contract`.

import {roomsActive} from '../../../core/agents/overview.ts'
import * as Hubs from '../../../core/hub/usecases/hubs.ts'
import * as Rooms from '../../../core/hub/usecases/rooms.ts'
import type {Hub} from '../../../core/hub/rooms/index.ts'
import {fail, short} from '../../../lib/index.ts'
import type {Opts} from '../args.ts'
import {flag, opt, out} from '../args.ts'

type Sub = (H: Hub, arg: string | undefined, o: Opts) => void
const list: Sub = H => {
  const rs = roomsActive(H)
  for (const r of rs) out(`${r.current ? '*' : ' '} ${r.name.padEnd(16)} ${r.members} member(s), ${r.active} active session(s), profile ${r.profile}  genesis ${short(r.genesis)}`)
  if (!rs.length) out(`no rooms in hub ${H.name}: ringi room create <id>`)
}
const create: Sub = (H, arg, o) => {
  const quorum = opt(o, 'quorum')
  const r = Rooms.create(H, arg ?? '', {profile: opt(o, 'profile'), quorum: quorum === undefined ? undefined : Number(quorum)})
  const start = quorum === undefined ? '' : ` Its work starts by itself at a quorum of ${quorum} agent(s).`
  out(`created room ${arg} in hub ${H.name} with profile ${r.profile}; it is the current room.${start} In each chat that should take part, say "join ${arg} as <id>"`)
}
const use: Sub = (H, arg) => {
  const R = Rooms.use(H, arg ?? fail('usage: ringi room switch <id>'))
  out(`current room: ${H.name}/${R.name}; agents keep their own rooms`)
}
const admit: Sub = (H, arg, o) => {
  const R = Rooms.roomIn(H, opt(o, 'room'))
  Rooms.admit(H, R, arg ?? fail('usage: ringi room admit <agent> <public key|file>'), o._[2] ?? fail('usage: ringi room admit <agent> <public key|file>'))
  out(`admitted ${arg} to ${H.name}/${R.name}: its signed messages are accepted from now on; it can join`)
}
const remove: Sub = (H, arg, o) => {
  const R = Rooms.roomIn(H, opt(o, 'room'))
  Rooms.remove(H, R, arg ?? fail('usage: ringi room remove <agent>'))
  out(`removed ${arg} from ${R.name}: it can no longer write or be woken there; returning needs a fresh join`)
}
// Without an id, the room of the current context.
const erase: Sub = (H, arg, o) => {
  const R = Rooms.roomIn(H, arg ?? opt(o, 'room'))
  if (!flag(o, 'yes')) fail(`deleting ${R.name} in hub ${H.name} erases it and everything kept for it, for good. Run again with --yes`)
  Rooms.erase(H, R)
  out(`deleted room ${R.name}: its branch, signals, pins, evidence and readers' state. Sessions bound to it leave it on their next turn`)
}
const rebase: Sub = (H, arg) => {
  const R = Rooms.roomIn(H, arg ?? fail('usage: ringi room rebase-contract <id>'))
  Rooms.rebase(H, R)
  out(`room ${R.name} now follows the hub contract at ${short(H.main)} (${H.contract.version})`)
}

const COMMANDS = new Map<string, Sub>([['list', list], ['create', create], ['switch', use], ['admit', admit], ['remove', remove], ['delete', erase], ['rebase-contract', rebase]])
export const roomCmd = (o: Opts) => {
  const [sub, arg] = o._
  const H = Hubs.hubOf(opt(o, 'hub'))
  const run = COMMANDS.get(sub || 'list') ?? fail(`unknown: room ${sub}`)
  run(H, arg, o)
}
