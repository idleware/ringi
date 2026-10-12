// propose: a proposal for the decider and its reviewers, its budget and revision checked before it is written
// (decisions/1).

import * as D from '../decisions/index.ts'
import {OPERATOR, append} from '../rooms/index.ts'
import {fail, note, short} from '../../../lib/index.ts'
import type {Entry} from '../protocol/files.ts'
import {ID_RE, checkOutgoing, compose, lookup} from '../protocol/index.ts'
import type {All, Message} from '../protocol/index.ts'
import {linked} from '../history/index.ts'
import {isRef} from './actor.ts'
import type {Actor} from './actor.ts'

export type ProposeInput = {text: string, decider: string, reviewers?: string[], budget?: string, due?: string, supersedes?: string, files?: Entry[]}
// Named reviewers, the proposer never among them.
const reviewersOf = (me: string, x: ProposeInput): string[] => {
  if (!ID_RE.test(x.decider)) fail(`bad decider ${x.decider}`)
  const reviewers = [...new Set(x.reviewers ?? [])].filter(r => r !== me)
  for (const r of reviewers) if (!ID_RE.test(r)) fail(`bad reviewer ${r}`)
  return reviewers
}
const budgetOf = (x: ProposeInput): D.Budget | null =>
  x.budget ? D.parseBudget(x.budget) ?? fail('--budget takes runs=<n>[, run-seconds=<n>][, concurrency=<n>]') : null
// A revision supersedes the actor's own proposal; the operator may revise anyone's.
const supersededOf = (all: All, me: string, ref: string | undefined): Message | null => {
  const sup = ref ? lookup(all, ref) : null
  const mine = sup?.kind === 'proposal' && (sup.from === me || me === OPERATOR)
  return !sup || mine ? sup : fail(`${short(sup.id)} is not your proposal`)
}
export const propose = ({R, me}: Actor, x: ProposeInput): {id: string, to: string[], budget: D.Budget | null} => {
  const {all} = linked(R, me)
  const reviewers = reviewersOf(me, x), budget = budgetOf(x), sup = supersededOf(all, me, x.supersedes)
  if (budget && !D.mayDecide(R.contract.authority, x.decider, me, budget)) note(`${x.decider} has no authority for this budget in hub ${R.hub.name}; only operator could approve it`)
  const to = [...new Set([...reviewers, x.decider])].filter(t => t !== me)
  const text = compose(x.text, [['To', to.join(', ') || '*'], ['Kind', 'proposal'], ['Decider', x.decider], ['Reviewers', reviewers.join(', ')],
    ['Due', x.due && D.parseDue(x.due)], ['Budget', budget && D.budgetText(budget)], ['Supersedes', sup?.id]])
  const bad = D.check(checkOutgoing(text, isRef(R)), isRef(R))
  if (bad) fail(`refusing to send: ${bad}`)
  return {id: append(R, me, text, x.files ?? []), to, budget}
}
