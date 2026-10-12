// roster: who belongs to a room and whose history its readers accept: admit a signed member, remove one, and accept a
// new baseline for a log after an alarm.

import {hubPorts, locked} from '../ports/index.ts'
import {OPERATOR, controlChange} from '../rooms/index.ts'
import type {Hub, Room} from '../rooms/index.ts'
import {fail} from '../../../lib/index.ts'
import {AGENT_RE, ID_RE} from '../protocol/index.ts'
import {loadState, readerLock, saveState} from '../history/index.ts'

// Removing, archiving or deleting in a signed hub needs revocation published to every replica: not in this version.
export const notSigned = (H: Hub, what: string) => { if (H.signed) fail(`room ${what} is not supported on signed hubs yet: a local change would come back with the next fetch`) }
export const admit = (H: Hub, R: Room, who: string, key: string): void => {
  if (!H.signed || !H.store.admit) fail('room admit is for signed hubs; on a local hub the operator\'s join adds members')
  if (!AGENT_RE.test(who)) fail(`bad agent id ${who}: lowercase letters, digits, - and _, no dot`)
  locked(`hub-${H.name}`, () => H.store.admit!(R.s, who, key))
}
export const remove = (H: Hub, R: Room, who: string): void => {
  notSigned(H, 'remove')
  if (!R.members[who]) fail(`${who} is not a member of ${R.name}`)
  if (who === OPERATOR) fail('the operator stays in every room')
  controlChange(R, OPERATOR, `remove ${who}`, m => { delete m[who] })
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
  R.hub.store.unpin(R.s, reader, id)
  return had
})
// The operator accepts a new baseline for one log, for every reader of the room, after reviewing an alarm. A signed
// store resets its transport pin too, keeping the displaced head as evidence; signatures are never waived.
export const forgetLog = (H: Hub, R: Room, id: string): number => {
  if (!ID_RE.test(id)) fail('usage: ringi forget <room>/<log>')
  if (H.signed) H.store.forgetLog?.(R.s, id)
  return hubPorts().state.list(['readers', H.name, R.genesis]).filter(reader => forgetIn(R, reader, id)).length
}
