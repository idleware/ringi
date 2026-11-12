// wait: an agent holds the line until something new arrives for it, or at most `max` seconds (and never past 110, so
// a tool call that runs it is not cut off).

import {HIDDEN} from '../../hub/rooms/index.ts'
import {fail, sleep} from '../../../lib/index.ts'
import {unread} from '../../hub/protocol/index.ts'
import {loadRoom, readersKey} from '../../hub/history/index.ts'
import {bound} from './index.ts'
import type {InboxOptions} from './agent.ts'
import {inbox} from './agent.ts'
import type {Actor} from '../../hub/usecases/room.ts'

export const wait = async (a: Actor, {max = 120, ...options}: InboxOptions & {max?: number} = {}) => {
  if (!Number.isFinite(max) || max < 0) fail('wait max must be nonnegative seconds')
  const start = Date.now(), until = start + Math.min(max, 110) * 1000
  for (;;) {
    // Each poll renews the lease and checks stop, takeover, membership and the room's identity.
    const current = bound()
    if (String(readersKey(current.R)) !== String(readersKey(a.R)) || current.me !== a.me) fail('the waiting session changed its binding')
    const {logs, st} = loadRoom(current.R, current.me)
    // The room as this poll found it shows the inbox and takes its delivery: a member admitted meanwhile counts.
    if (unread(logs, current.me, st.seen ?? {}, Infinity, HIDDEN).msgs.length) return {inbox: inbox(current, options), actor: current, seconds: (Date.now() - start) / 1000}
    if (Date.now() >= until) return {inbox: null, actor: current, seconds: (Date.now() - start) / 1000}
    await sleep(Math.min(1000, until - Date.now()))
  }
}
