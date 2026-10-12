// pings: the watcher answers pings for its agent without waking a model.

import type {Room} from '../../hub/rooms/index.ts'
import {append, pongText} from '../../hub/rooms/index.ts'
import {note, short} from '../../../lib/index.ts'
import type {Logs, Message} from '../../hub/protocol/index.ts'
import type {ReaderState} from '../../hub/history/index.ts'
import type {WatchContext} from './types.ts'

const allowed = (c: WatchContext, m: Message, answered: Set<string | null>): boolean => {
  const ping = !m.bad && m.kind === 'ping' && m.to.includes(c.me)
  const wake = m.hopEff < c.maxHop && (!c.allow || c.allow.has(m.from))
  return ping && !answered.has(m.id) && wake
}
const answerAuthor = (c: WatchContext, R: Room, msgs: Message[], last: string | undefined, answered: Set<string | null>): void => {
  const at = msgs.findIndex(m => m.id === last)
  for (const m of msgs.slice(at + 1)) {
    if (!allowed(c, m, answered)) continue
    append(R, c.me, pongText(c.me, m, 'has a watcher'))
    note(`watch: answered heartbeat ${short(m.id)} from ${m.from}`)
  }
}
export const answerWatchPings = (c: WatchContext, R: Room, logs: Logs, st: ReaderState): Record<string, string> => {
  const heartbeatSeen = {...st.heartbeatSeen}
  const answered = new Set((logs.get(c.me) ?? []).filter(m => m.kind === 'pong').map(m => m.reId))
  for (const [id, msgs] of logs) {
    if (id === c.me) continue
    answerAuthor(c, R, msgs, heartbeatSeen[id], answered)
    if (msgs.length) heartbeatSeen[id] = msgs.at(-1)!.id
  }
  return heartbeatSeen
}
