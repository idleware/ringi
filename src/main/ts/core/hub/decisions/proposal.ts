// proposal: one proposal folded over the messages that answer it, in thread order: its stamps, its decision, a
// revocation, a superseding revision; and the grant an approval with a budget makes.

import {one, ordered} from '../protocol/index.ts'
import type {All, Message} from '../protocol/index.ts'
import {ROOT, ids, mayDecide, parseBudget} from './budget.ts'
import type {AuthorityAt, Budget} from './budget.ts'

export type Grant = {id: string, budget: Budget, proposal: Message, revoked: boolean}
export type Proposal = {
  proposal: Message
  decider: string
  reviewers: string[]
  budget: Budget | null
  due: number | null
  stamps: Record<string, {stamp: string, id: string, reason: string}>
  missing: string[]
  decision: {decision: string, id: string, by: string, time: number} | null
  revoked: {id: string, by: string, time: number} | null
  superseded: Message | null
  state: string
  grant: Grant | null
}
type Ctx = {p: Message, decider: string, reviewers: string[], budget: Budget | null, authorityAt: AuthorityAt}
type Fold = Pick<Proposal, 'stamps' | 'decision' | 'revoked'>

const byOwner = (m: Message, p: Message): boolean => m.from === p.from || m.from === ROOT
// A revision supersedes only when its author is the proposer or the root.
const revises = (m: Message, p: Message): boolean => m.kind === 'proposal' && one(m, 'supersedes') === p.id && byOwner(m, p)
const answers = (m: Message, p: Message): boolean => m.reId === p.id && (m.kind === 'stamp' || m.kind === 'decision')
const among = (all: All, keep: (m: Message) => boolean): Message[] => ordered([...all.values()].filter(m => !m.bad && keep(m)))

// A decision names the room's control commit it was made under (`Control`); its authority is the table in effect
// there. A commit that does not exist yet cannot be named, so a later contract never promotes or demotes a decision.
const authorized = (c: Ctx, m: Message): boolean => {
  if (m.from === ROOT) return true
  const table = c.authorityAt(one(m, 'control'))
  return !!table && mayDecide(table, c.decider, c.p.from, c.budget)
}
const decides = (c: Ctx, m: Message): boolean => one(m, 'decision') !== 'revoked' && m.from === c.decider && authorized(c, m)
const revokes = (c: Ctx, m: Message): boolean => one(m, 'decision') === 'revoked' && (m.from === c.decider || m.from === ROOT)
const approved = (f: Fold): boolean => f.decision?.decision === 'approved'

// One answer applied: a reviewer's latest stamp counts (its position relative to the decision is only a same-second
// tie); the first decision of the decider with authority; then the first revocation of an approval.
const take = (c: Ctx, f: Fold, m: Message): void => {
  if (m.kind === 'stamp' && c.reviewers.includes(m.from)) f.stamps[m.from] = {stamp: one(m, 'stamp')!, id: m.id, reason: m.subject}
  if (m.kind !== 'decision') return
  if (!f.decision && decides(c, m)) f.decision = {decision: one(m, 'decision')!, id: m.id, by: m.from, time: m.time}
  else if (approved(f) && !f.revoked && revokes(c, m)) f.revoked = {id: m.id, by: m.from, time: m.time}
}
// The answers in thread order; one after the superseding revision no longer applies to this revision, except a
// revocation of an earlier approval.
const fold = (c: Ctx, list: Message[], superseded: Message | null): Fold => {
  const f: Fold = {stamps: {}, decision: null, revoked: null}
  for (const m of ordered([...list, ...(superseded ? [superseded] : [])])) {
    if (m === superseded) break
    take(c, f, m)
  }
  const late = superseded && approved(f) && !f.revoked ? list.find(m => revokes(c, m)) : undefined
  if (late) f.revoked = {id: late.id, by: late.from, time: late.time}
  return f
}
const stateOf = (f: Fold, superseded: Message | null, due: number | null, now: number): string => {
  if (f.revoked) return 'revoked'
  if (f.decision) return f.decision.decision
  if (superseded) return 'superseded'
  return due && now > due ? 'overdue' : 'open'
}
export const proposalOf = (all: All, p: Message, authorityAt: AuthorityAt, now = Date.now() / 1000): Proposal => {
  const c: Ctx = {p, decider: one(p, 'decider')!, reviewers: ids(one(p, 'reviewers')), budget: parseBudget(one(p, 'budget')) ?? null, authorityAt}
  const due = one(p, 'due') ? Date.parse(one(p, 'due')!) / 1000 : null
  const superseded = among(all, m => revises(m, p))[0] ?? null
  const f = fold(c, among(all, m => answers(m, p)), superseded)
  const grant = approved(f) && c.budget ? {id: f.decision!.id, budget: c.budget, proposal: p, revoked: !!f.revoked} : null
  return {proposal: p, decider: c.decider, reviewers: c.reviewers, budget: c.budget, due, ...f,
    missing: c.reviewers.filter(r => !f.stamps[r]), superseded, state: stateOf(f, superseded, due, now), grant}
}
export const proposals = (all: All, authorityAt: AuthorityAt): Proposal[] =>
  [...all.values()].filter(m => !m.bad && m.kind === 'proposal').map(p => proposalOf(all, p, authorityAt))
const decision = (d: Message | undefined): d is Message => !!d && !d.bad && d.kind === 'decision'
export const grantOf = (all: All, authorityAt: AuthorityAt, id: string): Grant | null => {
  const d = all.get(id)
  const p = decision(d) && d.reId ? all.get(d.reId) : undefined
  const g = p ? proposalOf(all, p, authorityAt).grant : null
  return g?.id === id ? g : null
}
