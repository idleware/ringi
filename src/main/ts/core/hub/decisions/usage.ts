// usage: what a grant's runs spent, from the usage receipts the runners write.

import {one, ordered} from '../protocol/index.ts'
import type {All, Message} from '../protocol/index.ts'
import type {AuthorityAt} from './budget.ts'
import {grantOf} from './proposal.ts'
import type {Grant} from './proposal.ts'

export type Usage = {runs: number, open: number, uncertain: number, seconds: number, left: number}
// The receipts a grant's ledger counts, in thread order: every reservation, and for each run (its runner and Run id)
// the first settlement after its reservation, as the first decision counts. A settlement of no reserved run counts
// nothing.
const ledger = (all: All, grant: Grant) => {
  const reserves: Message[] = [], settled = new Map<string, Message>(), reserved = new Set<string>()
  for (const m of ordered([...all.values()].filter(m => !m.bad && m.kind === 'usage' && one(m, 'grant') === grant.id))) {
    const run = `${m.from}/${one(m, 'run')}`
    if (one(m, 'usage') === 'reserve') {
      reserves.push(m)
      reserved.add(run)
    } else if (reserved.has(run) && !settled.has(run)) settled.set(run, m)
  }
  return {reserves, settled}
}
// Whether a receipt counts: its Grant names a grant, and that grant's ledger holds it.
export const counted = (all: All, authorityAt: AuthorityAt, m: Message): boolean => {
  const g = !m.bad && m.kind === 'usage' ? grantOf(all, authorityAt, one(m, 'grant') ?? '') : null
  if (!g) return false
  const {reserves, settled} = ledger(all, g)
  return reserves.includes(m) || [...settled.values()].includes(m)
}
// Usage from the runners' receipts: every reservation is a run, settled or not; an unsettled one is open while its
// run could still be going, and uncertain after that.
export const usageOf = (all: All, grant: Grant, now = Date.now() / 1000): Usage => {
  const {reserves, settled} = ledger(all, grant)
  let seconds = 0
  for (const m of settled.values()) seconds += Number(one(m, 'seconds'))
  const unsettled = reserves.filter(m => !settled.has(`${m.from}/${one(m, 'run')}`))
  const open = unsettled.filter(m => now - m.time <= grant.budget['run-seconds'] + 60)
  return {runs: reserves.length, open: open.length, uncertain: unsettled.length - open.length, seconds, left: Math.max(0, grant.budget.runs - reserves.length)}
}
