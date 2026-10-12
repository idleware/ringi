import {HIDDEN, append, pongText} from '../../hub/rooms/index.ts'
import {fail, sleep} from '../../../lib/index.ts'
import type {Message} from '../../hub/protocol/index.ts'
import {link, unread} from '../../hub/protocol/index.ts'
import {loadRoom} from '../../hub/history/index.ts'
import {bound} from './index.ts'
import type {InboxOptions} from './agent.ts'
import {inbox} from './agent.ts'
import type {Actor} from '../../hub/usecases/room.ts'

export const wait = async (a: Actor, {max = 120, ...options}: InboxOptions & {max?: number} = {}) => {
  if (!Number.isFinite(max) || max < 0) fail('wait max must be nonnegative seconds')
  const start = Date.now(), ponged = new Set<string>()
  let last = start, silence = Math.min(max, 110)
  for (;;) {
    // Each poll renews the lease and checks stop, takeover, membership and the room's identity.
    const current = bound()
    if (current.R.genesis !== a.R.genesis || current.me !== a.me) fail('the waiting session changed its binding')
    const {R, me} = current
    const {logs, st} = loadRoom(R, me)
    if (unread(logs, me, st.seen ?? {}, Infinity, HIDDEN).msgs.length) return {inbox: inbox(current, options), seconds: (Date.now() - start) / 1000}
    link(logs)
    const state = {last, silence, ponged}
    answerPings(current, logs, state)
    last = state.last; silence = state.silence
    const now = Date.now()
    if (now - last >= silence * 1000 || now - start >= max * 1000) return {inbox: null, seconds: (now - start) / 1000}
    await sleep(Math.min(1000, max * 1000 - (now - start)))
  }
}

type Waiting = {last: number, silence: number, ponged: Set<string>}
const answerPings = (a: Actor, logs: Map<string, Message[]>, state: Waiting): void => {
  for (const m of logs.get(a.me) ?? []) if (m.kind === 'pong' && m.reId) state.ponged.add(m.reId)
  for (const msgs of logs.values()) for (const m of msgs) {
    if (m.kind !== 'ping' || m.bad || !m.to.includes(a.me) || state.ponged.has(m.id)) continue
    state.ponged.add(m.id)
    state.last = Date.now()
    state.silence = Math.max(state.silence, Number(m.trailers.next?.[0]) || 600)
    append(a.R, a.me, pongText(a.me, m, 'is waiting'))
  }
}
