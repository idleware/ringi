// sessions: how a session shows in where, and `ringi forget <room>/<log>` (a new baseline for a log after an alarm).

import type {SessionView} from '../../../core/agents/overview.ts'
import * as Rooms from '../../../core/hub/usecases/rooms.ts'
import {fail} from '../../../lib/index.ts'
import type {Opts} from '../args.ts'
import {out} from '../args.ts'

export const sessionLine = (s: SessionView) => `${s.agent.padEnd(12)} ${s.liveness.padEnd(8)} ${(s.product ?? '?').padEnd(7)} ${s.handle}${s.scope ? `  scope: ${s.scope}` : ''}`

export const forget = (o: Opts) => {
  const m = /^(.+)\/([^/]+)$/.exec(o._[0] ?? '')
  if (!m) return fail('usage: ringi forget <room>/<log>')
  const [, name, id] = m
  const R = Rooms.roomNamed(name)
  const n = Rooms.forgetLog(R, id)
  out(`forgot the accepted history of ${name}/${id} for ${n} reader(s); the next read accepts what is there now`)
}
