// budget: proposals, reviewers' stamps, the decider's decision, and the grants it makes (decisions/1). Each operation
// takes who acts and typed input, and returns data; interfaces print it.

import * as D from '../decisions/index.ts'
import {locked} from '../ports/index.ts'
import {OPERATOR, append} from '../rooms/index.ts'
import {fail, note, short} from '../../../lib/index.ts'
import {checkOutgoing, compose, lookup} from '../protocol/index.ts'
import type {All, Message} from '../protocol/index.ts'
import {linked} from '../history/index.ts'
import {isRef} from './actor.ts'
import type {Actor} from './actor.ts'
import {grantView, proposalView} from './view.ts'
import type {GrantView, ProposalView} from './view.ts'

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
// Why the actor may not revoke the proposal's approval: only its decider or the operator revokes, and only an approval.
const revokeProblem = (info: D.Proposal, p: Message, me: string): string | null => {
  if (info.state !== 'approved') return `${short(p.id)} is ${info.state}; only an approval can be revoked`
  return me !== info.decider && me !== OPERATOR ? `only ${info.decider} or the operator revokes it` : null
}
// Why the actor may not decide the proposal: only its named decider with authority, once, on its latest revision.
const decideProblem = ({R, me}: Actor, info: D.Proposal, p: Message): string | null => {
  if (me !== info.decider) return `only the named decider, ${info.decider}, decides ${short(p.id)}`
  if (!D.mayDecide(R.contract.authority, me, p.from, info.budget)) return `${me} has no authority to decide this${info.budget ? ` budget (${D.budgetText(info.budget)})` : ''} in hub ${R.hub.name}, or it is your own proposal`
  if (info.decision) return `${short(p.id)} is already ${info.decision.decision}`
  return info.superseded ? `${short(p.id)} was superseded by ${short(info.superseded.id)}; decide that revision` : null
}
// The decision names the control entry, and so the authority, it was made under (decisions/1).
export const decide = ({R, me}: Actor, ref: string, d: string, text: string): {proposal: Message, id: string, budget: D.Budget | null} =>
  locked(`grant-${R.hub.name}`, () => {
    const {all} = linked(R, me)
    const p = proposalAt(all, ref)
    if (!D.DECISIONS.includes(d)) fail(`usage: decide <proposal> ${D.DECISIONS.join('|')} -m <reason>`)
    const info = D.proposalOf(all, p, R.authorityAt)
    const why = d === 'revoked' ? revokeProblem(info, p, me) : decideProblem({R, me}, info, p)
    if (why) fail(why)
    const to = [...new Set([p.from, ...info.reviewers])].filter(x => x !== me)
    const out = compose(text, [['To', to.join(', ') || '*'], ['Re', p.id], ['Kind', 'decision'], ['Decision', d], ['Control', R.head], ['Hop', String(p.hopEff + 1)]])
    checkOutgoing(out, isRef(R))
    const id = append(R, me, out)
    const approved = d === 'approved'
    if (approved && info.missing.length) note(`decided without stamps from ${info.missing.join(', ')}`)
    return {proposal: p, id, budget: approved ? info.budget : null}
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

export {propose} from './propose.ts'
export type {ProposeInput} from './propose.ts'
export {DECISIONS, STAMPS, budgetText} from '../decisions/index.ts'
