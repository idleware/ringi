import type {Room} from '../../hub/rooms/index.ts'
import {note, short} from '../../../lib/index.ts'
import type {All} from '../../hub/protocol/index.ts'
import type {ReaderState} from '../../hub/history/index.ts'
import {reportExhausted} from './exhaustion.ts'
import {reserveGrant} from './grants.ts'
import type {Group, Planning, Reserve, WatchContext} from './types.ts'

const ownRun = (c: WatchContext, grp: Group, p: Planning, now: number): void => {
  if (c.w.requireGrant) {
    for (const m of grp.msgs) note(`watch: ${short(m.id)} is outside any grant; --require-grant: not starting a turn`)
    return
  }
  if (p.ownRuns.length >= c.maxRuns) {
    p.hold = true
    note(`watch: own run budget spent (${c.maxRuns} per ${c.span}s); ${grp.msgs.length} message(s) wait`)
    return
  }
  p.ownRuns = [...p.ownRuns, now]
  p.runs.push({...grp, timeout: null})
}
const grantedRun = ({c, R, all, grp, r, p}: {c: WatchContext, R: Room, all: All, grp: Group, r: Reserve, p: Planning}): void => {
  if (r.wait) {
    p.hold = true
    note(`watch: ${r.why}; waiting`)
    return
  }
  if (r.why) {
    note(`watch: ${r.why}`)
    reportExhausted({c, R, all, grp, r, p})
    return
  }
  p.runs.push({...grp, run: r.run, timeout: r.gr!.budget['run-seconds']})
}
export const reserveGroups = (c: WatchContext, R: Room, all: All, groups: Map<string | null, Group>, st: ReaderState): Planning => {
  const now = Date.now() / 1000
  const p: Planning = {runs: [], hold: false, lost: false, ownRuns: (st.runs ?? []).filter(t => t > now - c.span), exhausted: {...st.exhausted}}
  for (const grp of groups.values()) {
    if (!grp.grant) {ownRun(c, grp, p, now); continue}
    const r = reserveGrant(c, R, all, grp)
    if (r.lost) return {...p, runs: [], hold: true, lost: true}
    grantedRun({c, R, all, grp, r, p})
  }
  return p
}
