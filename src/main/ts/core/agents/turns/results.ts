// results: a turn's end: its usage receipt settled, and its messages delivered or kept for a retry.

import type {Room} from '../../hub/rooms/index.ts'
import {OPERATOR, append} from '../../hub/rooms/index.ts'
import {note} from '../../../lib/index.ts'
import {compose} from '../../hub/protocol/index.ts'
import {loadState, readerLock, saveState} from '../../hub/history/index.ts'
import {dispatch} from './dispatch.ts'
import type {Ended} from '../ports/host.ts'
import type {Run, WatchContext} from './types.ts'

const settle = (c: WatchContext, R: Room, run: Run, result: {seconds: number, exit: number, why?: string}): string =>
  append(R, c.me, compose(`usage: settle a run of ${c.me}${result.why ? ` (${result.why})` : ''}`,
    [['To', OPERATOR], ['Kind', 'usage'], ['Grant', run.grant], ['Usage', 'settle'], ['Run', run.run], ['Seconds', String(result.seconds)], ['Exit', String(result.exit)]]))
const delivered = (c: WatchContext, R: Room, run: Run, r: Ended): void => readerLock(R, c.me, () => {
  const st = loadState(R, c.me), ids = new Set(run.msgs.map(m => m.id))
  const success = r.code === 0 || r.timedOut
  saveState(R, c.me, {
    ...st, inflight: undefined, ...(success
      ? {pending: (st.pending ?? []).filter(id => !ids.has(id))}
      : {seen: st.inflight?.seen ?? st.seen})
  })
})
const ended = (c: WatchContext, R: Room, run: Run, r: Ended): void => {
  note(`watch: exit ${r.code ?? r.signal}${r.timedOut ? ' (stopped at the grant\'s run-seconds)' : ''} after ${r.seconds}s`)
  if (run.run) settle(c, R, run, {seconds: r.seconds, exit: r.code ?? 128})
  delivered(c, R, run, r)
}
export const runTurns = async (c: WatchContext, R: Room, runs: Run[]): Promise<number> => {
  let exitCode = 0
  for (const run of runs) {
    const next = dispatch(c, R, run)
    if (next.why) {
      note(`watch: not starting the next turn: ${next.why}`)
      if (run.run) settle(c, R, run, {seconds: 0, exit: 125, why: `not started: ${next.why}`})
      continue
    }
    const r = await next.done!
    ended(c, R, run, r)
    if (r.code !== 0 || r.timedOut) exitCode ||= r.code || 128
  }
  return exitCode
}
