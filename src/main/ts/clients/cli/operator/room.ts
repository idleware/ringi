// room: `ringi room list | create | switch | invite | admit | remove | delete`, the rooms of this machine by address,
// or by name when one known room has it.

import fs from 'node:fs'
import {roomsActive} from '../../../core/agents/overview.ts'
import * as Rooms from '../../../core/hub/usecases/rooms.ts'
import * as Create from '../../../core/hub/usecases/room-create.ts'
import * as Access from '../../../core/hub/usecases/access.ts'
import * as Membership from '../../../core/hub/usecases/membership.ts'
import type {Invited} from '../../../core/hub/usecases/room-create.ts'
import {fail, short, words} from '../../../lib/index.ts'
import type {Opts} from '../args.ts'
import {flag, opt, out} from '../args.ts'

type Sub = (arg: string | undefined, o: Opts) => void | Promise<void>
const list: Sub = () => {
  const rs = roomsActive()
  for (const r of rs) out(`${r.current ? '*' : ' '} ${r.address}  ${r.members} member(s), ${r.active} active session(s), profile ${r.profile}, ${r.signed ? 'signed' : 'asserted'}  genesis ${short(r.genesis)}`)
  if (!rs.length) out('no rooms on this machine: ringi room create [<address>]')
}
// What the operator says in an invitee's chat on its machine: the account's line, and where the key goes first.
const inviteLines = (invites: Invited[]) => {
  for (const i of invites) out(`${i.login} joins as ${i.actor}: in its chat on its machine, the operator says "join <invitation>", which runs:\n  ringi join ${i.line}`)
}
// A bare name or `local://…` is a room here; `<forge>://host/space[/room]` one in that space, on the forge.
const create: Sub = async (arg, o) => {
  const quorum = opt(o, 'quorum')
  const r = await Create.create(arg, {profile: opt(o, 'profile'), quorum: quorum === undefined ? undefined : Number(quorum), invite: words(opt(o, 'invite') ?? ''),
    tokenFile: opt(o, 'token-file'), hostKeyFile: opt(o, 'host-key-file')})
  const address = r.R.endpoint.address, start = quorum === undefined ? '' : ` Its work starts by itself at a quorum of ${quorum} agent(s).`
  out(`created room ${address} with profile ${r.profile}; it is the current room.${start}`)
  if (!r.R.hub.signed) return out(`In each chat on this machine that should take part, say "join ${r.R.name}"`)
  inviteLines(r.invites)
  out(`Invite more accounts with ringi room invite <account> --room ${address}`)
}
const use: Sub = arg => {
  const R = Rooms.use(arg ?? fail('usage: ringi room switch <address|name>'))
  out(`current room: ${R.endpoint.address}; agents keep their own rooms`)
}
const invite: Sub = async (arg, o) => {
  const R = Rooms.roomNamed(opt(o, 'room'))
  inviteLines([await Create.invite(R, arg ?? fail('usage: ringi room invite <account> [--room <address>]'))])
}
// The key the invitee's join printed; the host proves it is on the invited account before anything is written.
const admit: Sub = async (arg, o) => {
  const usage = 'usage: ringi room admit <actor> <public key|file> [--room <address>]'
  const R = Rooms.roomNamed(opt(o, 'room')), actor = arg ?? fail(usage), key = o._[2] ?? fail(usage)
  if (!R.hub.signed) fail(`${R.endpoint.address} is a local room: agents on this machine join it by name`)
  const e = await Membership.admitInSpace(R, actor, fs.existsSync(key) ? fs.readFileSync(key, 'utf8') : key)
  out(`admitted ${actor} to ${R.endpoint.address}${'login' in e.principal ? ` as ${e.principal.login} on the forge` : ''}: its signed messages are accepted from now on; it can join`)
}
// For good: the actor's records stay, it writes nothing more, and its name is never given again in this room.
const remove: Sub = async (arg, o) => {
  const R = Rooms.roomNamed(opt(o, 'room')), actor = arg ?? fail('usage: ringi room remove <actor> [--room <address>]')
  if (R.hub.signed) await Membership.removeFromSpace(R, actor)
  else Membership.removeLocal(R, actor)
  out(`removed ${actor} from ${R.endpoint.address}${R.hub.signed ? ', and its rights on the forge' : ''}: what it wrote stays; it writes nothing more there`)
}
// Without an address, the room of the current context. With --server, the repository on the forge too, first.
const erase: Sub = async (arg, o) => {
  const r = Rooms.doomed(arg ?? opt(o, 'room')), server = flag(o, 'server')
  if (!flag(o, 'yes')) fail(`deleting ${r.address} takes it off this machine${server ? ' and erases its repository on the forge' : ''}, for good. Run again with --yes`)
  if (server) await Access.deleteServerRoom(r)
  const d = Rooms.erase(r)
  const files = d.quarantine ? `its repository moved aside to ${d.quarantine.path}` : `its repository stays at ${r.endpoint.location.directory.path}: remove it yourself if you want it gone`
  out(`deleted room ${r.address} on this machine${server ? ' and on the forge' : ''}: its records archived in ${d.archive}; ${files}. Sessions bound to it leave it on their next turn`)
}

const COMMANDS = new Map<string, Sub>([['list', list], ['create', create], ['switch', use], ['invite', invite], ['admit', admit], ['remove', remove], ['delete', erase]])
export const roomCmd = (o: Opts) => {
  const [sub, arg] = o._
  const run = COMMANDS.get(sub || 'list') ?? fail(`unknown: room ${sub}`)
  return run(arg, o)
}
