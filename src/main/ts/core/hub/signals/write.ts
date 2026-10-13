// signals (write side): an author stores the signals its message made and the marks it puts; readers check them
// (index.ts).

import {effective, markWhy} from './index.ts'
import {fail} from '../../../lib/index.ts'
import type {All, Message} from '../protocol/index.ts'
import type {Room} from '../rooms/index.ts'

// Puts one of the actor's marks on a message; false if it was already there.
export const mark = (R: Room, who: string, m: Message, name: string): boolean => {
  const why = markWhy(R, who, m, name)
  if (why) fail(`cannot mark ${m.id.slice(0, 12)} ${name}: ${why}`)
  const exists = R.store.signals(R.s).some(x => x.actor === who && x.target === m.id && x.signal === name)
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
