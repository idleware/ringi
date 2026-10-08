// budget: proposals, reviewers' stamps, the decider's decision, and the grants it makes (decisions/1). Each operation
// takes who acts and typed input, and returns data; interfaces print it.

import * as D from '../domain/decisions.ts'
import {OPERATOR, locked} from '../home/index.ts'
import {append} from '../hub/index.ts'
import {fail, note, short} from '../lib/index.ts'
import type {Entry} from '../protocol/files.ts'
import {ID_RE, checkOutgoing, compose, lookup} from '../protocol/index.ts'
import type {All, Message} from '../protocol/index.ts'
import {linked} from '../runtime/reader.ts'
import {isRef} from './room.ts'
import type {Actor} from './room.ts'
import {grantView, proposalView} from './view.ts'
import type {GrantView, ProposalView} from './view.ts'

export type ProposeInput = {text: string, decider: string, reviewers?: string[], budget?: string, due?: string, supersedes?: string, files?: Entry[]}
export const propose = ({R, me}: Actor, x: ProposeInput): {id: string, to: string[], budget: D.Budget | null} => {
  const {all} = linked(R, me)
  if (!ID_RE.test(x.decider)) fail(`bad decider ${x.decider}`)
  const reviewers = [...new Set(x.reviewers ?? [])].filter(r => r !== me)
  for (const r of reviewers) if (!ID_RE.test(r)) fail(`bad reviewer ${r}`)
  const budget = x.budget ? D.parseBudget(x.budget) ?? fail('--budget takes runs=<n>[, run-seconds=<n>][, concurrency=<n>]') : null
  const sup = x.supersedes ? lookup(all, x.supersedes) : null
  if (sup && (sup.kind !== 'proposal' || (sup.from !== me && me !== OPERATOR))) fail(`${short(sup.id)} is not your proposal`)
  if (budget && !D.mayDecide(R.contract.authority, x.decider, me, budget)) note(`${x.decider} has no authority for this budget in hub ${R.hub.name}; only operator could approve it`)
  const to = [...new Set([...reviewers, x.decider])].filter(t => t !== me)
  const text = compose(x.text, [['To', to.join(', ') || '*'], ['Kind', 'proposal'], ['Decider', x.decider], ['Reviewers', reviewers.join(', ')],
    ['Due', x.due && D.parseDue(x.due)], ['Budget', budget && D.budgetText(budget)], ['Supersedes', sup?.id]])
  const bad = D.check(checkOutgoing(text, isRef(R)), isRef(R))
  if (bad) fail(`refusing to send: ${bad}`)
  return {id: append(R, me, text, x.files ?? []), to, budget}
}
const proposalAt = (all: All, ref: string): Message => {
  const p = lookup(all, ref)
  if (p.kind !== 'proposal' || p.bad) fail(`${short(p.id)} is not a proposal`)
  return p
}
export const stamp = ({R, me}: Actor, ref: string, s: string, text: string): {proposal: Message, id: string} => {
  const {all} = linked(R, me)
  const p = proposalAt(all, ref)
  if (!D.STAMPS.includes(s)) fail(`usage: stamp <proposal> ${D.STAMPS.join('|')} -m <reason>`)
  const info = D.proposalOf(all, p, R.authorityAt)
  if (!info.reviewers.includes(me)) fail(`you are not a named reviewer of ${short(p.id)} (reviewers: ${info.reviewers.join(', ') || 'none'})`)
  if (info.decision) fail(`${short(p.id)} is already ${info.decision.decision}`)
  const out = compose(text, [['To', [...new Set([p.from, info.decider])].filter(x => x !== me).join(', ') || p.from], ['Re', p.id], ['Kind', 'stamp'], ['Stamp', s], ['Hop', String(p.hopEff + 1)]])
  checkOutgoing(out, isRef(R))
  return {proposal: p, id: append(R, me, out)}
}
// The decision names the control entry, and so the authority, it was made under (decisions/1).
export const decide = ({R, me}: Actor, ref: string, d: string, text: string): {proposal: Message, id: string, budget: D.Budget | null} =>
  locked(`grant-${R.hub.name}`, () => {
    const {all} = linked(R, me)
    const p = proposalAt(all, ref)
    if (!D.DECISIONS.includes(d)) fail(`usage: decide <proposal> ${D.DECISIONS.join('|')} -m <reason>`)
    const info = D.proposalOf(all, p, R.authorityAt)
    if (d === 'revoked') {
      if (info.state !== 'approved') fail(`${short(p.id)} is ${info.state}; only an approval can be revoked`)
      if (me !== info.decider && me !== OPERATOR) fail(`only ${info.decider} or the operator revokes it`)
    } else {
      if (me !== info.decider) fail(`only the named decider, ${info.decider}, decides ${short(p.id)}`)
      if (!D.mayDecide(R.contract.authority, me, p.from, info.budget)) fail(`${me} has no authority to decide this${info.budget ? ` budget (${D.budgetText(info.budget)})` : ''} in hub ${R.hub.name}, or it is your own proposal`)
      if (info.decision) fail(`${short(p.id)} is already ${info.decision.decision}`)
      if (info.superseded) fail(`${short(p.id)} was superseded by ${short(info.superseded.id)}; decide that revision`)
    }
    const to = [...new Set([p.from, ...info.reviewers])].filter(x => x !== me)
    const out = compose(text, [['To', to.join(', ') || '*'], ['Re', p.id], ['Kind', 'decision'], ['Decision', d], ['Control', R.head], ['Hop', String(p.hopEff + 1)]])
    checkOutgoing(out, isRef(R))
    const id = append(R, me, out)
    if (d === 'approved' && info.missing.length) note(`decided without stamps from ${info.missing.join(', ')}`)
    return {proposal: p, id, budget: d === 'approved' ? info.budget : null}
  })
// Open proposals (with `all`, every one).
export const proposals = ({R, me}: Actor, {all: everything = false}: {all?: boolean} = {}): {proposals: D.Proposal[], views: ProposalView[]} => {
  const {all} = linked(R, me)
  const ps = D.proposals(all, R.authorityAt).filter(x => everything || ['open', 'overdue'].includes(x.state))
  return {proposals: ps, views: ps.map(proposalView)}
}
export const grants = ({R, me}: Actor): GrantView[] => {
  const {all} = linked(R, me)
  return D.proposals(all, R.authorityAt).filter(x => x.grant).map(x => grantView(x, D.usageOf(all, x.grant!)))
}

export {DECISIONS, STAMPS, budgetText} from '../domain/decisions.ts'
