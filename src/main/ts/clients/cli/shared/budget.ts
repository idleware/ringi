import * as Budget from '../../../core/hub/usecases/budget.ts'
import {fail, short, words} from '../../../lib/index.ts'
import type {Opts} from '../args.ts'
import {attachments, dump, flag, list, opt, out, textOf} from '../args.ts'
import type {Ctx} from '../context.ts'

// --- decisions and budgets ---

export const propose = (a: Ctx, o: Opts) => {
  const decider = opt(o, 'decider') ?? fail('--decider <id> is required: who decides (operator, or someone with authority in the hub contract)')
  const r = Budget.propose(a, {
    text: textOf(o), decider, reviewers: words(opt(o, 'reviewers')), budget: opt(o, 'budget'), due: opt(o, 'due'),
    supersedes: opt(o, 'supersedes'), files: list(o, 'attach').flatMap(attachments)
  })
  out(`proposed ${short(r.id)} to ${r.to.join(', ') || 'the room'}; decider ${decider}${r.budget ? `, budget ${Budget.budgetText(r.budget)}` : ''}`)
}

export const stamp_ = (a: Ctx, o: Opts) => {
  const s = o._[1] ?? ''
  if (!Budget.STAMPS.includes(s)) fail(`usage: stamp <proposal> ${Budget.STAMPS.join('|')} -m <reason>`)
  const r = Budget.stamp(a, o._[0] ?? fail('name the proposal'), s, textOf(o))
  out(`stamped ${short(r.proposal.id)} ${s}: ${short(r.id)}`)
}

export const decide = (a: Ctx, o: Opts) => {
  const d = o._[1] ?? ''
  if (!Budget.DECISIONS.includes(d)) fail(`usage: decide <proposal> ${Budget.DECISIONS.join('|')} -m <reason>`)
  const r = Budget.decide(a, o._[0] ?? fail('name the proposal'), d, textOf(o))
  out(`${d} ${short(r.proposal.id)}: ${short(r.id)}${r.budget ? `; grant ${short(r.id)} with ${Budget.budgetText(r.budget)}. Work spends it with --grant ${short(r.id)}` : ''}`)
}

export const proposals = (a: Ctx, o: Opts) => {
  const {proposals: ps, views} = Budget.proposals(a, {all: flag(o, 'all')})
  if (flag(o, 'json')) return dump(views)
  if (!ps.length) return out(flag(o, 'all') ? 'no proposals' : 'no open proposals (proposals --all for everything)')
  for (const x of ps) {
    const st = x.reviewers.map(r => `${r}:${x.stamps[r]?.stamp ?? '-'}`).join(' ')
    out(`${short(x.proposal.id)}  ${x.state.padEnd(10)} ${x.proposal.from} → ${x.decider}${x.budget ? `  [${Budget.budgetText(x.budget)}]` : ''}${st ? `  ${st}` : ''}  ${x.proposal.subject}`)
  }
}

export const grants = (a: Ctx, o: Opts) => {
  const gs = Budget.grants(a)
  if (flag(o, 'json')) return dump(gs)
  if (!gs.length) return out('no grants')
  for (const g of gs) {
    const u = g.usage
    out(`${short(g.grant)}  ${g.revoked ? 'revoked ' : u.left ? 'active  ' : 'spent   '} runs ${u.runs}/${g.budget.runs}, open ${u.open}${u.uncertain ? `, uncertain ${u.uncertain}` : ''}, ${u.seconds}s used, ≤${g.budget['run-seconds']}s a run, concurrency ${g.budget.concurrency}  ${g.subject}`)
  }
}
