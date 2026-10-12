import * as D from '../../hub/decisions/index.ts'
import {hubPorts, locked} from '../../hub/ports/index.ts'
import type {Room} from '../../hub/rooms/index.ts'
import {fail, note, short} from '../../../lib/index.ts'
import {link} from '../../hub/protocol/index.ts'
import {loadRoomUnlocked, loadState, readerLock, saveState} from '../../hub/history/index.ts'
import {readSession} from '../sessions/index.ts'
import {agentPorts} from '../ports/index.ts'
import type {Ended} from '../ports/host.ts'
import type {Run, WatchContext} from './types.ts'

type Dispatch = {why?: string, done?: Promise<Ended>}
const grantProblem = (c: WatchContext, R: Room, run: Run): string | undefined => {
  if (!run.grant) return undefined
  const {logs} = readerLock(R, c.me, () => loadRoomUnlocked(R, c.me))
  const gr = D.grantOf(link(logs), R.authorityAt, run.grant)
  return !gr ? 'its grant is no longer valid' : gr.revoked ? 'its grant was revoked' : undefined
}
const spawnTurn = (c: WatchContext, run: Run): Dispatch => locked('sessions', () => {
  const cur = readSession(c.handle)
  if (!cur || cur.pid !== process.pid) return {why: 'the seat was taken over'}
  if (cur.state !== 'active') return {why: 'the watcher was stopped'}
  note(`watch: ${run.msgs.length} new${run.grant ? ` under grant ${short(run.grant)}` : ''}: ${c.cmd}`)
  return {
    done: agentPorts().host.awaitQuiescence(agentPorts().host.start({shell: c.cmd, timeout: run.timeout, env: {
      ...process.env, RINGI_HOME: hubPorts().state.root, RINGI_SESSION: c.raw,
      RINGI_MSGS: run.msgs.map(m => m.id).join('\n'), RINGI_GRANT: run.grant ?? ''
    }})).then(result => result ?? fail('the process host did not settle the turn'))
  }
})
export const dispatch = (c: WatchContext, R: Room, run: Run): Dispatch => locked(`grant-${R.hub.name}`, () => {
  const why = grantProblem(c, R, run)
  if (why) return {why}
  readerLock(R, c.me, () => {
    const st = loadState(R, c.me)
    saveState(R, c.me, {...st, inflight: {seen: st.seen ?? {}}})
  })
  return spawnTurn(c, run)
})
