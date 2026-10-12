import {config} from '../../../core/hub/usecases/context.ts'
import * as Hubs from '../../../core/hub/usecases/hubs.ts'
import * as Overview from '../../../core/agents/overview.ts'
import type {Hub, Room} from '../../../core/hub/rooms/index.ts'
import {sleep} from '../../../lib/index.ts'
import type {Opts} from '../args.ts'
import {flag, opt, out} from '../args.ts'
import {hubLine, printOverview, showMessage} from './where-format.ts'

const follow = async (H: Hub, R: Room, o: Opts, seen: Set<string>) => {
  out('following; new messages appear as they land (Ctrl-C to stop)')
  for (;;) {
    await sleep(Number(opt(o, 'interval') ?? 2) * 1000)
    const now = Overview.arrived(H, R, seen)
    for (const m of now.messages) showMessage(R, o, now.all, m)
  }
}
export const where = async (o: Opts) => {
  const H = Hubs.hubOf(opt(o, 'hub'))
  const w = Overview.where(H, opt(o, 'room') ?? config().room)
  out(hubLine(H))
  const R = w.room
  if (!R) return out('no current room: ringi room create <id> | ringi room switch <id>')
  printOverview(w, R)
  const n = Number(opt(o, 'n') ?? (flag(o, 'short') ? 10 : 5))
  out(`last ${Math.min(n, w.messages.length)} of ${w.messages.length} messages:`)
  for (const m of w.messages.slice(-n)) showMessage(R, o, w.all, m)
  if (flag(o, 'follow')) await follow(H, R, o, new Set(w.all.keys()))
}
