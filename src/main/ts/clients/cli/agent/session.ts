// session: what the operator says in an agent's chat (join, continue, stop, leave) becomes the session's requests.
import * as Heartbeat from '../../../core/agents/heartbeat/pulse.ts'
import * as Session from '../../../core/agents/sessions/session.ts'
import {fail} from '../../../lib/index.ts'
import {opt, out} from '../args.ts'
import type {Opts} from '../args.ts'
import {showInbox} from './index.ts'
import {scopeLine, taskLine, waiting} from '../shared/index.ts'

export const briefing = (s: Session.Session) => {
  const r = Session.briefing(s)
  const auto = r.start.quorum !== null
  out(`${s.agent} in ${s.room}; scope: ${scopeLine(s, auto)}`)
  out('agent commands: ringi agent inbox | reply <id> … | send … | tasks | proposals | whoami. A turn: inbox, your part, replies, end the turn. Never block on a peer.')
  if (!r.start.started) return out(waiting(s.room, r.start))
  if (auto) out(`started: room ${s.room} has its quorum (${r.start.agents} of ${r.start.quorum} agents); your first turn starts now, on the work and inbox below; nothing to confirm with the operator`)
  if (!r.tasks.length) out(`no open work (profile ${r.actor.R.profile.name}; tasks --all for everything)`)
  for (const task of r.tasks) out(taskLine(task))
  showInbox(r.actor, r.inbox!, {_: []})
}
export const join = (o: Opts) => {
  const [room] = o._
  if (!room) fail('usage: ringi join <room or its invitation> [--as <id>] [--scope "<what the operator delegates>"]')
  const r = Session.join({room, agent: opt(o, 'as'), scope: opt(o, 'scope')})
  if (r.key) {
    out(`${r.agent}'s key on this machine (${r.key.fingerprint}). Ask the root to admit it, then join again:\n  ringi room admit ${r.agent} '${r.key.publicKey}' --room ${r.room}`)
    process.exitCode = 3
    return
  }
  out(`joined ${r.room} as ${r.agent}`)
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
  out(`stopped: ${s.agent} keeps its seat in ${s.room} and reacts to nothing until the operator says "continue"`)
}
export const leave = () => {
  const s = Session.leave()
  out(`left ${s.room}: the seat of ${s.agent} is free; ${s.agent} stays a member until the operator removes it`)
}
