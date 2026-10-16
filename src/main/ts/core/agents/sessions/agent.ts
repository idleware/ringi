// agent: what an agent does in its room as itself: read its inbox (marking what it read), take a piece of work, show
// who it is, wait.

import {HIDDEN, start, withSizes} from '../../hub/rooms/index.ts'
import * as Signals from '../../hub/signals/write.ts'
import {fail} from '../../../lib/index.ts'
import {link, lookup, unread} from '../../hub/protocol/index.ts'
import {linked, loadRoomUnlocked, loadState, readerLock, saveState} from '../../hub/history/index.ts'
import type {Session} from './index.ts'
import type {Actor} from '../../hub/usecases/room.ts'
export {wait} from './wait.ts'

export {bound} from './index.ts'

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
  // One read per log reached: the last message of each that was delivered (signals/marks.ts).
  if (!peek) for (const m of new Map(res.msgs.map(m => [m.from, m])).values()) Signals.mark(R, me, m, 'read', res.all)
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
