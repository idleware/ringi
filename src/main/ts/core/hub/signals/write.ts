// signals (write side): an author stores the signals its message made and the marks it puts; readers check them
// (index.ts).

import {effective, markWhy, signalName} from './index.ts'
import {fail} from '../../../lib/index.ts'
import type {All, Message} from '../protocol/index.ts'
import type {Room} from '../rooms/index.ts'

// Puts one of the actor's marks on a message; false if it was already there.
export const mark = (R: Room, who: string, m: Message, name: string): boolean => {
  const why = markWhy(R, who, m, name)
  if (why) fail(`cannot mark ${m.id.slice(0, 12)} ${name}: ${why}`)
  if (R.hub.store.signals(R.s).some(x => x.actor === who && x.name === signalName(m.id, name))) return false
  R.hub.store.signal(R.s, who, m.id, signalName(m.id, name))
  return true
}
// Writes the signals of one of the author's own messages that are not stored yet.
export const emit = (R: Room, who: string, all: All, m: Message): number => {
  const have = new Set(R.hub.store.signals(R.s).filter(x => x.actor === who).map(x => x.name))
  let n = 0
  for (const signal of effective(R, all, m)) {
    if (have.has(signalName(m.id, signal))) continue
    R.hub.store.signal(R.s, who, m.id, signalName(m.id, signal))
    n++
  }
  return n
}