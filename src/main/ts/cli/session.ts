// Session interface: the operator's words become typed app requests.
import * as Heartbeat from '../app/heartbeat.ts'
import * as Session from '../app/session.ts'
import {fail} from '../lib/index.ts'
import {opt, out} from './args.ts'
import type {Opts} from './args.ts'
import {showInbox} from './agent.ts'
import {scopeLine, taskLine, waiting} from './shared.ts'

export const briefing = (s: Session.Session) => {
  const r = Session.briefing(s)
  const auto = r.start.quorum !== null
  out(`${s.agent} in ${s.hub}/${s.room}; scope: ${scopeLine(s, auto)}`)
  out('agent commands: ringi agent inbox | reply <id> … | send … | tasks | proposals | whoami. A turn: inbox, your part, replies, end the turn. Never block on a peer.')
  if (!r.start.started) return out(waiting(s.room, r.start))
  if (auto) out(`started: room ${s.room} has its quorum (${r.start.agents} of ${r.start.quorum} agents); your first turn starts now, on the work and inbox below; nothing to confirm with the operator`)
  if (!r.tasks.length) out(`no open work (profile ${r.actor.R.profile.name}; tasks --all for everything)`)
  for (const task of r.tasks) out(taskLine(task))
  showInbox(r.actor, r.inbox!, {_: []})
}
export const join = (o: Opts) => {
  const [hub, room] = o._
  if (!hub || !room) fail('usage: ringi join <hub> <room> [--as <id>] [--scope "<what the operator delegates>"]')
  const r = Session.join({hub, room, agent: opt(o, 'as'), scope: opt(o, 'scope')})
  if (r.key) {
    out(`${r.agent}'s key on this machine (${r.key.fingerprint}). Ask the root to admit it, then join again:\n  ringi room admit ${r.agent} '${r.key.publicKey}' --hub ${r.hub} --room ${r.room}`)
    process.exitCode = 3
    return
  }
  out(`joined ${r.hub}/${r.room} as ${r.agent}`)
  Heartbeat.ensurePulse(process.argv[1])
  briefing(r.session!)
}
export const resume = (o: Opts) => {
  const s = Session.resume(o._[0])
  Heartbeat.ensurePulse(process.argv[1])
  briefing(s)
}
export const stop = () => {
  const s = Session.stop()
  out(`stopped: ${s.agent} keeps its seat in ${s.hub}/${s.room} and reacts to nothing until the operator says "continue"`)
}
export const leave = () => {
  const s = Session.leave()
  out(`left ${s.hub}/${s.room}: the seat of ${s.agent} is free; ${s.agent} stays a member until the operator removes it`)
}
