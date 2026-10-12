// messages: what wakes the watcher: new messages for its agent and retries of failed turns, grouped by grant and work.

import {isOpen, taskFor, taskOf} from '../../hub/work/index.ts'
import type {Room} from '../../hub/rooms/index.ts'
import {HIDDEN} from '../../hub/rooms/index.ts'
import {note, short} from '../../../lib/index.ts'
import type {All, Logs, Message} from '../../hub/protocol/index.ts'
import {unread, wakes} from '../../hub/protocol/index.ts'
import type {ReaderState} from '../../hub/history/index.ts'
import type {Group, WatchContext} from './types.ts'

export const collectMessages = (c: WatchContext, R: Room, logs: Logs, st: ReaderState, all: All) => {
  const {msgs: fresh, cursors} = unread(logs, c.me, st.watched ?? st.seen ?? {}, Infinity, HIDDEN)
  const retry = (st.pending ?? []).flatMap(id => {
    const m = all.get(id)
    if (!m) return []
    const task = taskFor(all, m, R.profile)
    return !task || isOpen(taskOf(all, task, R.profile), R.profile) ? [m] : []
  })
  const msgs = [...new Map([...retry, ...fresh].map(m => [m.id, m])).values()]
  const go = msgs.filter(m => wakes(m, c.me, HIDDEN) && m.hopEff < c.maxHop && (!c.allow || c.allow.has(m.from)))
  for (const m of msgs) if (!go.includes(m)) note(`watch: not waking for ${short(m.id)} from ${m.from} (to ${m.to.join(',')}, hop ${m.hopEff})`)
  return {retry, cursors, go}
}
export const groupMessages = (R: Room, all: All, go: Message[]): Map<string | null, Group> => {
  const groups = new Map<string | null, Group>()
  for (const m of go) {
    const task = taskFor(all, m, R.profile), g = task ? taskOf(all, task, R.profile).grant : null
    if (!groups.has(g)) groups.set(g, {grant: g, msgs: [], task})
    groups.get(g)!.msgs.push(m)
  }
  return groups
}
