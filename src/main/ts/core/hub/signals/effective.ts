// effective: the signals a message made, judged on the room as it is now (thread order is fixed, so this does not
// change).

import * as D from '../decisions/index.ts'
import {taskFor, taskOf} from '../work/index.ts'
import {one} from '../protocol/index.ts'
import type {All, Message} from '../protocol/index.ts'
import type {RoomModel} from './model.ts'

const isWorkSignal = (fx: string): boolean => fx === 'opened' || fx === 'assigned' || fx.startsWith('state.')
// What the message did to its piece of work: opened, assigned, a state.
const workSignals = (R: RoomModel, all: All, m: Message): string[] => {
  const work = taskFor(all, m, R.profile)
  return work ? (taskOf(all, work, R.profile).effects.get(m.id) ?? []).filter(isWorkSignal) : []
}
// A proposal, and a usage receipt its grant's ledger counts.
const ownSignals = (R: RoomModel, all: All, m: Message): string[] => [
  ...m.kind === 'proposal' ? ['proposed'] : [],
  ...m.kind === 'usage' && D.counted(all, R.authorityAt, m) ? [`usage.${one(m, 'usage')}`] : [],
]
// An answer to a proposal: a counted stamp, the decision, its revocation.
const answerSignals = (R: RoomModel, all: All, m: Message): string[] => {
  const p = m.reId ? all.get(m.reId) : undefined
  if (p?.kind !== 'proposal' || p.bad) return []
  const info = D.proposalOf(all, p, R.authorityAt)
  const decided = m.kind === 'decision'
  return [
    ...m.kind === 'stamp' && info.reviewers.includes(m.from) ? [`stamp.${one(m, 'stamp')}`] : [],
    ...decided && info.decision?.id === m.id ? [`decision.${info.decision.decision}`] : [],
    ...decided && info.revoked?.id === m.id ? ['decision.revoked'] : [],
  ]
}
export const effective = (R: RoomModel, all: All, m: Message): string[] =>
  m.bad || m.invalid ? [] : [...workSignals(R, all, m), ...ownSignals(R, all, m), ...answerSignals(R, all, m)]
