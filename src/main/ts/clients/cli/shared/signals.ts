import * as Room from '../../../core/hub/usecases/room.ts'
import type {Checked} from '../../../core/hub/signals/index.ts'
import {note, short, when} from '../../../lib/index.ts'
import type {Opts} from '../args.ts'
import {dump, flag, opt, out} from '../args.ts'
import type {Ctx} from '../context.ts'

export const signals = (a: Ctx, o: Opts) => {
  const res = Room.signals(a, {repair: flag(o, 'repair')})
  if (res.repaired !== null) out(`restored ${res.repaired} signal(s) of ${a.me}`)
  for (const x of res.alarms) note(`ALARM ${x}`)
  if (flag(o, 'json')) return dump(res.checked)
  const at = (c: Checked) => res.all.get(c.target)?.time ?? 0
  const sorted = [...res.checked].sort((x, y) => at(x) - at(y))
  const shown = flag(o, 'all') ? sorted : sorted.slice(-Number(opt(o, 'n') ?? 20))
  if (!shown.length) return out('no signals')
  for (const c of shown) out(`${short(c.target)}  ${when(at(c)).slice(5)}  ${c.actor.padEnd(10)} ${c.signal.padEnd(20)} ${c.ok ? res.all.get(c.target)?.subject ?? '' : `MISMATCH: ${c.why}`}`)
}
