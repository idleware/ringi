// roster: who belongs to a room and whose history its readers accept: admit a signed member, and accept a new
// baseline for a log after an alarm.

import {hubPorts, locked} from '../ports/index.ts'
import {OPERATOR} from '../rooms/index.ts'
import type {Hub, Room} from '../rooms/index.ts'
import {fail} from '../../../lib/index.ts'
import {AGENT_RE, ID_RE} from '../protocol/index.ts'
import {loadState, readerLock, saveState} from '../history/index.ts'

// An agent's id in a room: `operator` is the root, `main` and `chat` name a room's own branches (hub-2).
const RESERVED = new Set([OPERATOR, 'main', 'chat'])
export const agentId = (who: string): string =>
  AGENT_RE.test(who) && !RESERVED.has(who) ? who : fail(`bad agent id ${who}: lowercase letters, digits, - and _, no dot; not ${[...RESERVED].join(', ')}`)
export const admit = (H: Hub, R: Room, who: string, key: string): void => {
  if (!H.signed || !R.store.admit) fail('room admit is for signed hubs; on a local hub the operator\'s join adds members')
  agentId(who)
  locked(`hub-${H.name}`, () => R.store.admit!(R.s, who, key))
}
// One reader forgets the log's accepted head and the alarms about it; whether it had accepted any.
const forgetIn = (R: Room, reader: string, id: string): boolean => readerLock(R, reader, () => {
  const st = loadState(R, reader)
  const heads = st.heads ?? {}, had = !!heads[id]
  if (had) {
    delete heads[id]
    st.alarms = (st.alarms ?? []).filter(a => !a.startsWith(`log ${id} `) && !a.startsWith(`log ${id}:`))
    saveState(R, reader, st)
  }
  R.store.unpin(R.s, reader, id)
  return had
})
// The operator accepts a new baseline for one log, for every reader of the room, after reviewing an alarm. A signed
// store resets its transport pin too, keeping the displaced head as evidence; signatures are never waived.
export const forgetLog = (H: Hub, R: Room, id: string): number => {
  if (!ID_RE.test(id)) fail('usage: ringi forget <room>/<log>')
  if (H.signed) R.store.forgetLog?.(R.s, id)
  return hubPorts().state.list(['readers', H.d.genesis, R.genesis]).filter(reader => forgetIn(R, reader, id)).length
}
