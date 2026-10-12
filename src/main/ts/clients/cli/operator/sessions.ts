import * as Hubs from '../../../core/hub/usecases/hubs.ts'
import type {SessionView} from '../../../core/agents/overview.ts'
import * as Overview from '../../../core/agents/overview.ts'
import * as Rooms from '../../../core/hub/usecases/rooms.ts'
import {fail} from '../../../lib/index.ts'
import type {Opts} from '../args.ts'
import {dump, flag, opt, out} from '../args.ts'

// --- where things stand, sessions, forget ---

export const sessionLine = (s: SessionView) => `${s.agent.padEnd(12)} ${s.liveness.padEnd(8)} ${(s.product ?? '?').padEnd(7)} ${s.handle}${s.scope ? `  scope: ${s.scope}` : ''}`

export const sessions = (o: Opts) => {
  if (o._[0] === 'forget') {
    const handle = o._[1] ?? fail('usage: ringi sessions forget <handle>')
    Overview.forgetSession(handle)
    return out(`forgot session ${handle}; its seat is free`)
  }
  const ss = Overview.sessions()
  if (flag(o, 'json')) return dump(ss)
  if (!ss.length) return out('no sessions')
  for (const s of ss) out(`${s.hub}/${s.room}  ${sessionLine(s)}`)
}

export const forget = (o: Opts) => {
  const [name, id] = (o._[0] ?? '').split('/')
  if (!name || !id) fail('usage: ringi forget <room>/<log>')
  const H = Hubs.hubOf(opt(o, 'hub'))
  const n = Rooms.forgetLog(H, Rooms.roomIn(H, name), id)
  out(`forgot the accepted history of ${name}/${id} for ${n} reader(s); the next read accepts what is there now`)
}
