import * as D from '../../hub/decisions/index.ts'
import type {Room} from '../../hub/rooms/index.ts'
import {OPERATOR, append} from '../../hub/rooms/index.ts'
import {short} from '../../../lib/index.ts'
import type {All} from '../../hub/protocol/index.ts'
import {compose} from '../../hub/protocol/index.ts'
import {readSession} from '../sessions/index.ts'
import type {Group, Reserve, WatchContext} from './types.ts'

const grantStatus = (gr: D.Grant): Reserve => {
  if (gr.revoked) return {why: `grant ${short(gr.id)} was revoked`, exhausted: true, gr}
  return {gr}
}
const remaining = (all: All, gr: D.Grant): Reserve => {
  const u = D.usageOf(all, gr)
  if (u.left <= 0) return {why: `grant ${short(gr.id)} is spent: ${u.runs}/${gr.budget.runs} runs`, exhausted: true, gr}
  if (u.open >= gr.budget.concurrency) return {why: `grant ${short(gr.id)} has ${u.open} run(s) open, concurrency ${gr.budget.concurrency}`, wait: true}
  return {gr}
}
export const reserveGrant = (c: WatchContext, R: Room, all: All, grp: Group): Reserve => {
  if (readSession(c.handle)?.pid !== process.pid) return {why: 'this watcher no longer holds the seat', lost: true}
  const gr = D.grantOf(all, R.authorityAt, grp.grant!)
  if (!gr) return {why: `grant ${short(grp.grant!)} is not an approved decision with a budget`}
  const status = grantStatus(gr)
  if (status.why) return status
  const balance = remaining(all, gr)
  if (balance.why) return balance
  const run = `${c.raw}.${process.pid}.${Date.now().toString(36)}.${c.runSeq++}`
  append(R, c.me, compose(`usage: reserve a run of ${c.me}`, [['To', OPERATOR], ['Kind', 'usage'], ['Grant', gr.id], ['Usage', 'reserve'], ['Run', run]]))
  return {gr, run}
}
