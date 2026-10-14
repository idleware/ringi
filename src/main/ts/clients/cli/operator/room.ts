// room: `ringi room list | create | switch | admit | delete`, the rooms of this machine by name, whatever hub keeps them.

import fs from 'node:fs'
import {roomsActive} from '../../../core/agents/overview.ts'
import * as Hubs from '../../../core/hub/usecases/hubs.ts'
import * as Rooms from '../../../core/hub/usecases/rooms.ts'
import * as Access from '../../../core/hub/usecases/access.ts'
import {fail, short} from '../../../lib/index.ts'
import type {Opts} from '../args.ts'
import {flag, opt, out} from '../args.ts'

type Sub = (arg: string | undefined, o: Opts) => void | Promise<void>
const list: Sub = () => {
  const rs = roomsActive()
  for (const r of rs) out(`${r.current ? '*' : ' '} ${r.name.padEnd(16)} ${r.members} member(s), ${r.active} active session(s), profile ${r.profile}, hub ${r.hub}  genesis ${short(r.genesis)}`)
  if (!rs.length) out('no rooms on this machine: ringi room create <id>')
}
// In hub `local` unless --hub names another.
const create: Sub = async (arg, o) => {
  const H = Hubs.hubOf(opt(o, 'hub'))
  const quorum = opt(o, 'quorum')
  const r = await Rooms.create(H, arg ?? '', {profile: opt(o, 'profile'), quorum: quorum === undefined ? undefined : Number(quorum), url: opt(o, 'url')})
  const start = quorum === undefined ? '' : ` Its work starts by itself at a quorum of ${quorum} agent(s).`
  out(`created room ${arg} in hub ${H.name} with profile ${r.profile}; it is the current room.${start} In each chat that should take part, say "join ${arg} as <id>"`)
  if (r.join) out(`Its invitation: in an agent's chat on another machine, the operator says "join <invitation> as <id>", which runs:\n  ${r.join}`)
}
const use: Sub = arg => {
  const R = Rooms.use(arg ?? fail('usage: ringi room switch <id>'))
  out(`current room: ${R.name}; agents keep their own rooms`)
}
// On a hub whose rooms a forge keeps, `--as` names the agent's account there: it gets the room, the chat and its own
// streams, and its key on that account if the operator's token may put it there.
const admit: Sub = async (arg, o) => {
  const usage = 'usage: ringi room admit <agent> <public key|file> [--as <account on the forge>]'
  const R = Rooms.roomNamed(opt(o, 'room')), agent = arg ?? fail(usage), key = o._[2] ?? fail(usage), as = opt(o, 'as')
  if (R.hub.d.access && !as) fail(`${R.name} is kept on a forge: name ${agent}'s account there with --as`)
  Rooms.admit(R.hub, R, agent, key)
  if (as) await Access.grantRoom(R, agent, as, fs.existsSync(key) ? fs.readFileSync(key, 'utf8') : key)
  out(`admitted ${agent} to ${R.name}${as ? ` as ${as} on the forge` : ''}: its signed messages are accepted from now on; it can join`)
}
// Without an id, the room of the current context.
// With --server, the repository on the forge too, first.
const erase: Sub = async (arg, o) => {
  const R = Rooms.roomNamed(arg ?? opt(o, 'room')), server = flag(o, 'server')
  if (!flag(o, 'yes')) fail(`deleting ${R.name} erases its store on this machine${server ? ' and on the forge' : ''} and everything kept for it, for good. Run again with --yes`)
  if (server) await Access.deleteServerRoom(R)
  Rooms.erase(R)
  out(`deleted room ${R.name}: its repository, signals, pins, evidence and readers' state on this machine${server ? ', and its repository on the forge' : ''}. Sessions bound to it leave it on their next turn`)
}

const COMMANDS = new Map<string, Sub>([['list', list], ['create', create], ['switch', use], ['admit', admit], ['delete', erase]])
export const roomCmd = (o: Opts) => {
  const [sub, arg] = o._
  const run = COMMANDS.get(sub || 'list') ?? fail(`unknown: room ${sub}`)
  return run(arg, o)
}
