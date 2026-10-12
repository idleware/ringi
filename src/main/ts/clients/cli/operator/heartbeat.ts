import * as Heartbeat from '../../../core/agents/heartbeat/pulse.ts'
import * as Hubs from '../../../core/hub/usecases/hubs.ts'
import * as Rooms from '../../../core/hub/usecases/rooms.ts'
import type {Opts} from '../args.ts'
import {dump, flag, opt, out} from '../args.ts'
import {publishedLine, pulseLine} from './heartbeat-format.ts'

const published = (o: Opts) => {
  const R = Rooms.roomIn(Hubs.hubOf(opt(o, 'hub')), opt(o, 'room'))
  const hs = Heartbeat.published(R)
  if (flag(o, 'json')) return dump(hs)
  if (!hs.length) return out(`no heartbeats in ${R.name}`)
  for (const h of hs) out(publishedLine(h))
}
const local = async (o: Opts) => {
  const ps = await Heartbeat.heartbeats()
  if (flag(o, 'json')) return dump(ps)
  if (!ps.length) return out('no sessions')
  for (const p of ps) out(pulseLine(p))
}
export const heartbeats = async (o: Opts) => {
  if (flag(o, 'published')) published(o)
  else await local(o)
}
export const pulse = async (o: Opts) => {
  process.exitCode = await Heartbeat.pulse({every: Number(opt(o, 'beat') ?? 30), once: flag(o, 'once'), log: s => process.stderr.write(`ringi: ${s}\n`)})
}
