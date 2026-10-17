// agent: the commands only an agent runs, as the agent its session is bound to (`ringi agent inbox`, whoami, wait,
// take); joining and leaving a room are session.ts.
import * as Agent from '../../../core/agents/sessions/agent.ts'
import {asJson, render} from '../../../core/hub/usecases/view.ts'
import {addressOf} from '../../../core/hub/usecases/rooms.ts'
import {fail, short} from '../../../lib/index.ts'
import {dump, flag, opt, out} from '../args.ts'
import type {Opts} from '../args.ts'
import type {Ctx} from '../context.ts'
import {scopeLine, waiting} from '../shared/index.ts'

const options = (o: Opts) => ({peek: flag(o, 'peek'), limit: opt(o, 'limit') ? Number(opt(o, 'limit')) : undefined})
export const showInbox = ({R, me, s}: Ctx, res: Agent.Inbox, o: Opts) => {
  if (flag(o, 'json')) return dump(res.msgs.map(asJson))
  if (!res.msgs.length) return out('inbox: nothing new')
  out(`inbox: ${res.msgs.length} new for ${me} in ${addressOf(R)} (senders ${R.hub.signed ? 'verified by signature' : 'asserted, not verified'})${s?.scope ? `\nyour scope: ${s.scope}` : ''}`)
  for (const m of res.msgs) out(`\n${render(res.all, m, {max: 4000})}`)
  if (res.rest) out(`\n(${res.rest} more: run ringi agent inbox again)`)
}
export const inbox = (a: Ctx, o: Opts) => {
  const st = Agent.started(a)
  if (!st.started) return out(waiting(addressOf(a.R), st))
  showInbox(a, Agent.inbox(a, options(o)), o)
}
export const take = (a: Ctx, o: Opts) => {
  const {m, made} = Agent.take(a, o._[0] ?? fail('usage: ringi agent take <work>'))
  out(`${made ? 'took' : 'already took'} ${short(m.id)}: ${m.subject}`)
}
export const whoami = (a: Ctx) => {
  const {session: s, profile, members} = Agent.whoami(a)
  out(`${s.agent} in ${s.room} (genesis ${short(s.genesis)}, profile ${profile}), session ${s.handle}, ${s.state}\nscope: ${scopeLine(s, a.R.quorum !== null)}\nmembers: ${members.join(', ')}`)
}
export const wait = async (a: Ctx, o: Opts) => {
  const r = await Agent.wait(a, {...options(o), max: opt(o, 'max') === undefined ? undefined : Number(opt(o, 'max'))})
  if (r.inbox) return showInbox(a, r.inbox, o)
  out(`wait: nothing for ${a.me} in ${Math.round(r.seconds)}s`)
  process.exitCode = 3
}
