// Agent operations return data; the runtime owns readers, seats and headless turns.
import {HIDDEN, append, pongText, start, withSizes} from '../hub/index.ts'
import * as Signals from '../hub/signals.ts'
import {fail, sleep} from '../lib/index.ts'
import {ID_RE, checkOutgoing, compose, link, lookup, unread} from '../protocol/index.ts'
import {linked, loadRoom, loadRoomUnlocked, loadState, readerLock, saveState} from '../runtime/reader.ts'
import {bound} from '../runtime/session.ts'
import type {Session} from '../runtime/session.ts'
import {isRef} from './room.ts'
import type {Actor} from './room.ts'

export {bound} from '../runtime/session.ts'
export {watch} from '../runtime/watch.ts'
export type {WatchOptions} from '../runtime/watch.ts'

export type InboxOptions = {peek?: boolean, limit?: number}
// Whether the agent's room has its quorum and started its work; a room that has not is not read.
export const started = ({R}: Actor) => start(R)
export const inbox = ({R, me}: Actor, {peek = false, limit = 20}: InboxOptions = {}) => {
  if (!Number.isSafeInteger(limit) || limit < 1) fail('inbox limit must be a positive integer')
  const res = readerLock(R, me, () => {
    const {logs, st} = loadRoomUnlocked(R, me)
    const r = unread(logs, me, st.seen ?? {}, limit, HIDDEN)
    if (!peek) saveState(R, me, {...loadState(R, me), seen: r.cursors})
    return {all: link(logs), ...r}
  })
  if (!peek) for (const m of res.msgs) Signals.mark(R, me, m, 'read')
  return {...res, msgs: res.msgs.map(m => ({...m, files: withSizes(R, m)}))}
}
export type Inbox = ReturnType<typeof inbox>
export const take = ({R, me}: Actor, ref: string) => {
  const m = lookup(linked(R, me).all, ref)
  return {m, made: Signals.mark(R, me, m, 'taken')}
}
export const whoami = ({s, R}: Actor & {s?: Session}) => ({
  session: s ?? fail('agent identity needs a joined session'), profile: R.profile.name, members: Object.keys(R.members),
})
export const card = ({R, me}: Actor, text: string): string => {
  const message = compose(text, [['To', '*'], ['Kind', 'card']])
  checkOutgoing(message, isRef(R))
  return append(R, me, message)
}
export type PingInput = {to: string, text?: string, next?: number, re?: string}
export const ping = ({R, me}: Actor, {to, text = 'ping: still working', next = 600, re}: PingInput) => {
  if (!ID_RE.test(to)) fail(`bad recipient ${to}`)
  if (!Number.isFinite(next) || next <= 0) fail('ping next must be positive seconds')
  const {all} = linked(R, me)
  const mine = [...all.values()].filter(m => m.from === me && m.kind === 'ping' && m.to.includes(to)).at(-1)
  const pong = mine && [...all.values()].find(m => m.kind === 'pong' && m.from === to && m.reId === mine.id)
  const parent = re ? lookup(all, re) : null
  const message = compose(text, [['To', to], ['Re', parent?.id], ['Kind', 'ping'], ['Next', String(next)], ['Hop', parent && String(parent.hopEff + 1)]])
  checkOutgoing(message, isRef(R))
  return {id: append(R, me, message), to, previous: mine ? {id: mine.id, answeredAt: pong?.time ?? null} : null}
}
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
    for (const m of logs.get(me) ?? []) if (m.kind === 'pong' && m.reId) ponged.add(m.reId)
    for (const msgs of logs.values()) for (const m of msgs) {
      if (m.kind !== 'ping' || m.bad || !m.to.includes(me) || ponged.has(m.id)) continue
      ponged.add(m.id)
      last = Date.now()
      silence = Math.max(silence, Number(m.trailers.next?.[0]) || 600)
      append(R, me, pongText(me, m, 'is waiting'))
    }
    const now = Date.now()
    if (now - last >= silence * 1000 || now - start >= max * 1000) return {inbox: null, seconds: (now - start) / 1000}
    await sleep(Math.min(1000, max * 1000 - (now - start)))
  }
}
