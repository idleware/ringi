// room: `ringi room list | create | switch | admit | delete`, the rooms of this machine by name, whatever hub keeps them.

import {roomsActive} from '../../../core/agents/overview.ts'
import * as Hubs from '../../../core/hub/usecases/hubs.ts'
import * as Rooms from '../../../core/hub/usecases/rooms.ts'
import {fail, short} from '../../../lib/index.ts'
import type {Opts} from '../args.ts'
import {flag, opt, out} from '../args.ts'

type Sub = (arg: string | undefined, o: Opts) => void
const list: Sub = () => {
  const rs = roomsActive()
  for (const r of rs) out(`${r.current ? '*' : ' '} ${r.name.padEnd(16)} ${r.members} member(s), ${r.active} active session(s), profile ${r.profile}, hub ${r.hub}  genesis ${short(r.genesis)}`)
  if (!rs.length) out('no rooms on this machine: ringi room create <id>')
}
// In hub `local` unless --hub names another.
const create: Sub = (arg, o) => {
  const H = Hubs.hubOf(opt(o, 'hub'))
  const quorum = opt(o, 'quorum')
  const r = Rooms.create(H, arg ?? '', {profile: opt(o, 'profile'), quorum: quorum === undefined ? undefined : Number(quorum), url: opt(o, 'url')})
  const start = quorum === undefined ? '' : ` Its work starts by itself at a quorum of ${quorum} agent(s).`
  out(`created room ${arg} in hub ${H.name} with profile ${r.profile}; it is the current room.${start} In each chat that should take part, say "join ${arg} as <id>"`)
  if (r.join) out(`Its invitation: in an agent's chat on another machine, the operator says "join <invitation> as <id>", which runs:\n  ${r.join}`)
}
const use: Sub = arg => {
  const R = Rooms.use(arg ?? fail('usage: ringi room switch <id>'))
  out(`current room: ${R.name}; agents keep their own rooms`)
}
const admit: Sub = (arg, o) => {
  const R = Rooms.roomNamed(opt(o, 'room'))
  Rooms.admit(R.hub, R, arg ?? fail('usage: ringi room admit <agent> <public key|file>'), o._[2] ?? fail('usage: ringi room admit <agent> <public key|file>'))
  out(`admitted ${arg} to ${R.name}: its signed messages are accepted from now on; it can join`)
}
// Without an id, the room of the current context.
const erase: Sub = (arg, o) => {
  const R = Rooms.roomNamed(arg ?? opt(o, 'room'))
  if (!flag(o, 'yes')) fail(`deleting ${R.name} erases its store on this machine and everything kept for it, for good. Run again with --yes`)
  Rooms.erase(R)
  out(`deleted room ${R.name}: its repository, signals, pins, evidence and readers' state on this machine. Sessions bound to it leave it on their next turn`)
}

const COMMANDS = new Map<string, Sub>([['list', list], ['create', create], ['switch', use], ['admit', admit], ['delete', erase]])
export const roomCmd = (o: Opts) => {
  const [sub, arg] = o._
  const run = COMMANDS.get(sub || 'list') ?? fail(`unknown: room ${sub}`)
  run(arg, o)
}
