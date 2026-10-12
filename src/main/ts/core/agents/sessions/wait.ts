// wait: an agent holds the line until something new arrives for it, or at most `max` seconds (and never past 110, so
// a tool call that runs it is not cut off).

import {HIDDEN} from '../../hub/rooms/index.ts'
import {fail, sleep} from '../../../lib/index.ts'
import {unread} from '../../hub/protocol/index.ts'
import {loadRoom} from '../../hub/history/index.ts'
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
    if (current.R.genesis !== a.R.genesis || current.me !== a.me) fail('the waiting session changed its binding')
    const {logs, st} = loadRoom(current.R, current.me)
    if (unread(logs, current.me, st.seen ?? {}, Infinity, HIDDEN).msgs.length) return {inbox: inbox(current, options), seconds: (Date.now() - start) / 1000}
    if (Date.now() >= until) return {inbox: null, seconds: (Date.now() - start) / 1000}
    await sleep(Math.min(1000, until - Date.now()))
  }
}
