// Headless turns hold one seat and charge only the runner's reservations and receipts.
import {note, sleep} from '../../../lib/index.ts'
import {planTurns} from './plan.ts'
import {pollWatcher} from './poll.ts'
import {runTurns} from './results.ts'
import {createWatcher} from './seat.ts'
import type {WatchContext, WatchOptions} from './types.ts'
export type {Room} from '../../hub/rooms/index.ts'
export type {WatchOptions} from './types.ts'

export const watch = async (w: WatchOptions, log: (line: string) => void = note): Promise<number> => {
  const c = createWatcher(w, log)
  for (;;) {
    const done = await watchTick(c)
    if (done !== undefined) return done
    await sleep(c.interval)
  }
}

const watchTick = async (c: WatchContext): Promise<number | undefined> => {
  const poll = pollWatcher(c)
  if (poll.done) return 0
  if (poll.R) {
    const plan = planTurns(c, poll.R)
    if (plan.lost) {c.log(`watch: the seat of ${c.me} was taken over; stopping`); return 0}
    const exitCode = await runTurns(c, poll.R, plan.runs)
    if (c.w.once) return exitCode || (plan.hold ? 4 : 0)
  }
  return undefined
}
