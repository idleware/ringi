import {roomsActive} from '../../../core/agents/overview.ts'
import * as Rooms from '../../../core/hub/usecases/rooms.ts'
import type {Hub} from '../../../core/hub/rooms/index.ts'
import {fail, short} from '../../../lib/index.ts'
import type {Opts} from '../args.ts'
import {flag, opt, out} from '../args.ts'

export const listRoom = (H: Hub, arg: string | undefined, o: Opts) => {
  const rs = roomsActive(H, {archived: flag(o, 'archived')})
  for (const r of rs.filter(r => !r.archived)) out(`${r.current ? '*' : ' '} ${r.name.padEnd(16)} ${r.members} member(s), ${r.active} active session(s), profile ${r.profile}  genesis ${short(r.genesis)}`)
  for (const r of rs.filter(r => r.archived)) out(`  ${r.name.padEnd(16)} archived, read-only`)
  if (!rs.length && !flag(o, 'archived')) out(`no rooms in hub ${H.name}: ringi room create <id>`)
  return
}

export const createRoom = (H: Hub, arg: string | undefined, o: Opts) => {
  const quorum = opt(o, 'quorum')
  const r = Rooms.create(H, arg ?? '', {profile: opt(o, 'profile'), quorum: quorum === undefined ? undefined : Number(quorum)})
  if (quorum !== undefined) return out(`created room ${arg} in hub ${H.name} with profile ${r.profile}; it is the current room. Its work starts by itself at a quorum of ${quorum} agent(s): in each chat that should take part, say "join ${arg} as <id>"`)
  return out(`created room ${arg} in hub ${H.name} with profile ${r.profile}; it is the current room. In each chat that should take part, say: "join ${arg} as <id>; <what to accept>"`)
}

export const switchRoom = (H: Hub, arg: string | undefined, o: Opts) => {
  const R = Rooms.use(H, arg ?? fail('usage: ringi room switch <id>'))
  return out(`current room: ${H.name}/${R.name}; agents keep their own rooms`)
}

export const migrateRoom = (H: Hub, arg: string | undefined, o: Opts) => {
  const rev = Rooms.migrate(H, arg ?? fail('usage: ringi room migrate <id>'))
  return out(`room ${arg} uses one branch; its genesis, message ids and session bindings are kept (${short(rev)})`)
}
