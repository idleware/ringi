// where-format: how `ringi where` shows the hub, the room, who is in, open work and the latest messages.

import type {Where} from '../../../core/agents/overview.ts'
import {withSizes} from '../../../core/hub/usecases/room.ts'
import {oneLine, render} from '../../../core/hub/usecases/view.ts'
import type {Room} from '../../../core/hub/rooms/index.ts'
import {short} from '../../../lib/index.ts'
import type {All, Message} from '../../../core/hub/protocol/index.ts'
import type {Opts} from '../args.ts'
import {flag, out} from '../args.ts'
import {taskLine} from '../shared/index.ts'
import {sessionLine} from './sessions.ts'

// The room's hub and the contract the room follows: a room carries its own copy (hub-2).
export const hubLine = (R: Room) => `hub ${R.hub.name}: ${R.hub.d.store.type} store, ${R.hub.d.trust} senders, contract ${R.contract.version}, protocol ${R.contract.protocol}${R.contract.capabilities?.length ? `, ${R.contract.capabilities.join(' ')}` : ''}`
const quorumLine = (R: Room) => {
  if (R.quorum === null) return ''
  const agents = Object.values(R.members).filter(m => m.role !== 'root').length
  return agents >= R.quorum ? `; started at its quorum of ${R.quorum} agents` : `; waiting for a quorum of ${R.quorum} agents, has ${agents}`
}
const roomLine = (R: Room) => `room ${R.name}, genesis ${short(R.genesis)}, profile ${R.profile.name}; members: ${Object.entries(R.members).map(([id, i]) => i.role === 'root' ? `${id} (root)` : id).join(', ')}` + quorumLine(R)
export const printOverview = (w: Where, R: Room) => {
  out(roomLine(R))
  out(w.sessions.length ? `sessions:\n${w.sessions.map(s => `  ${sessionLine(s)}`).join('\n')}` : 'sessions: none joined')
  out(w.work.length ? `open work:\n${w.work.map(t => `  ${taskLine(t)}`).join('\n')}` : 'open work: none')
}
export const showMessage = (R: Room, o: Opts, all: All, m: Message) => out(flag(o, 'short') ? `  ${oneLine(m)}` : `\n${render(all, m, {max: 2000, files: () => withSizes(R, m)})}`)
