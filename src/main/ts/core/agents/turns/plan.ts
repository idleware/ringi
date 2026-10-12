// plan: one loop's turns: what arrived, grouped and reserved; planning and dispatch take locks in the order grant,
// reader, sessions.

import {locked} from '../../hub/ports/index.ts'
import type {Room} from '../../hub/rooms/index.ts'
import {link} from '../../hub/protocol/index.ts'
import {loadRoomUnlocked, loadState, readerLock, saveState} from '../../hub/history/index.ts'
import {reserveGroups} from './budgets.ts'
import {collectMessages, groupMessages} from './messages.ts'
import {answerWatchPings} from './pings.ts'
import type {Plan, WatchContext} from './types.ts'

const planUnlocked = (c: WatchContext, R: Room): Plan => {
  const {logs, st} = loadRoomUnlocked(R, c.me)
  if (st.inflight) {
    st.seen = st.inflight.seen
    st.inflight = undefined
    saveState(R, c.me, st)
  }
  const all = link(logs), heartbeatSeen = answerWatchPings(c, R, logs, st)
  const {retry, cursors, go} = collectMessages(c, R, logs, st, all)
  const p = reserveGroups(c, R, all, groupMessages(R, all, go), st)
  if (p.lost) return {runs: [], hold: true, lost: true}
  const pending = [...new Set([...retry.map(m => m.id), ...p.runs.flatMap(r => r.msgs.map(m => m.id))])]
  saveState(R, c.me, {
    ...loadState(R, c.me), heartbeatSeen, exhausted: p.exhausted, pending, runs: p.ownRuns,
    ...(p.hold ? {} : {watched: cursors})
  })
  return {runs: p.runs, hold: p.hold, lost: false}
}
export const planTurns = (c: WatchContext, R: Room): Plan =>
  locked(`grant-${R.hub.name}`, () => readerLock(R, c.me, () => planUnlocked(c, R)))
