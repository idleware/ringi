// effective: the signals a message made, judged on the room as it is now (thread order is fixed, so this does not
// change).

import {taskFor, taskOf} from '../work/index.ts'
import type {All, Message} from '../protocol/index.ts'
import type {RoomModel} from './model.ts'

const isWorkSignal = (fx: string): boolean => fx === 'opened' || fx === 'assigned' || fx.startsWith('state.')
// What the message did to its piece of work: opened, assigned, a state.
const workSignals = (R: RoomModel, all: All, m: Message): string[] => {
  const work = taskFor(all, m, R.profile)
  return work ? (taskOf(all, work, R.profile).effects.get(m.id) ?? []).filter(isWorkSignal) : []
}
export const effective = (R: RoomModel, all: All, m: Message): string[] =>
  m.bad || m.invalid ? [] : workSignals(R, all, m)
