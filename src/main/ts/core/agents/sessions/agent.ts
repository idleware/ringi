// agent: what an agent does in its room as itself: read its inbox (marking what it read), take a piece of work, show
// who it is, leave its card, wait and ping; the headless watcher is turns/.

import {HIDDEN, append, start, withSizes} from '../../hub/rooms/index.ts'
import * as Signals from '../../hub/signals/write.ts'
import {fail} from '../../../lib/index.ts'
import {ID_RE, checkOutgoing, compose, link, lookup, unread} from '../../hub/protocol/index.ts'
import {linked, loadRoomUnlocked, loadState, readerLock, saveState} from '../../hub/history/index.ts'
import type {Session} from './index.ts'
import type {Actor} from '../../hub/usecases/room.ts'
import {isRef} from '../../hub/usecases/room.ts'
export {wait} from './wait.ts'

export {bound} from './index.ts'

export {watch} from '../turns/index.ts'

export type {WatchOptions} from '../turns/index.ts'

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
