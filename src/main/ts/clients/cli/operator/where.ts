// where: `ringi where`, where things stand for the operator, and `--follow` for what lands next.

import {config} from '../../../core/hub/usecases/context.ts'
import * as Overview from '../../../core/agents/overview.ts'
import type {RoomV2} from '../../../core/hub/rooms/index.ts'
import {sleep} from '../../../lib/index.ts'
import type {Opts} from '../args.ts'
import {flag, opt, out} from '../args.ts'
import {hubLine, printOverview, showMessage} from './where-format.ts'

const follow = async (R: RoomV2, o: Opts, seen: Set<string>) => {
  out('following; new messages appear as they land (Ctrl-C to stop)')
  for (;;) {
    await sleep(Number(opt(o, 'interval') ?? 2) * 1000)
    const now = Overview.arrived(R, seen)
    for (const m of now.messages) showMessage(R, o, now.all, m)
  }
}
export const where = async (o: Opts) => {
  const w = Overview.where(opt(o, 'room') ?? config().room)
  const R = w.room
  if (!R) return out('no current room: ringi room create [<address>] | ringi room switch <address>')
  out(hubLine(R))
  printOverview(w, R)
  const n = Number(opt(o, 'n') ?? (flag(o, 'short') ? 10 : 5))
  out(`last ${Math.min(n, w.messages.length)} of ${w.messages.length} messages:`)
  for (const m of w.messages.slice(-n)) showMessage(R, o, w.all, m)
  if (flag(o, 'follow')) await follow(R, o, new Set(w.all.keys()))
}
