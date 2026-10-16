// signals (write side): an author stores the signals its message made and the marks it puts; readers check them
// (index.ts).

import {check, effective, markWhy} from './index.ts'
import {fail} from '../../../lib/index.ts'
import type {All, Message} from '../protocol/index.ts'
import type {Room} from '../rooms/index.ts'

// A read its actor's cursor in that log already passed: a later message of the same author it marked read, by a mark
// that passes the same check the fold counts (signals/marks.ts).
const covered = (R: Room, who: string, m: Message, all: All): boolean => check(R, all, R.store.signals(R.s)).some(c => {
  const t = c.ok && c.actor === who && c.signal === 'read' ? all.get(c.target) : undefined
  return !!t && t.from === m.from && t.seq > m.seq
})
// Puts one of the actor's marks on a message; false if it was already there. The same mark again is written again, so
// one kept but not yet published is retried; a read the cursor already passed adds no record (signals/marks.ts).
export const mark = (R: Room, who: string, m: Message, name: string, all?: All): boolean => {
  const why = markWhy(R, who, m, name)
  if (why) fail(`cannot mark ${m.id.slice(0, 12)} ${name}: ${why}`)
  const exists = R.store.signals(R.s).some(x => x.actor === who && x.target === m.id && x.signal === name)
  if (!exists && name === 'read' && all && covered(R, who, m, all)) return false
  R.store.signal(R.s, who, m.id, name)
  return !exists
}
// Writes the signals of one of the author's own messages that are not stored yet.
export const emit = (R: Room, who: string, all: All, m: Message): number => {
  const have = new Set(R.store.signals(R.s).filter(x => x.actor === who).map(x => JSON.stringify([x.target, x.signal])))
  let n = 0
  for (const signal of effective(R, all, m)) {
    R.store.signal(R.s, who, m.id, signal)
    if (!have.has(JSON.stringify([m.id, signal]))) n++
  }
  return n
}
