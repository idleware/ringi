import * as Room from '../../../core/hub/usecases/room.ts'
import type {TaskView} from '../../../core/hub/usecases/view.ts'
import {asJson, oneLine} from '../../../core/hub/usecases/view.ts'
import {short, when} from '../../../lib/index.ts'
import type {Opts} from '../args.ts'
import {dump, flag, opt, out} from '../args.ts'
import type {Ctx} from '../context.ts'

export const taskLine = (t: TaskView) => {
  const roles = Object.keys(t.roles).length ? ` [${Object.entries(t.roles).map(([id, label]) => `${id}=${label}`).join(' ')}]` : ''
  return `${short(t.id)}  ${t.state.padEnd(14)} ${t.requester} → ${t.assignees.join(',') || '(open)'}${roles}${t.taken.length ? ` taken by ${t.taken.join(',')}` : ''}${t.grant ? ` grant ${short(t.grant)}` : ''}  ${when(Date.parse(t.at) / 1000).slice(5)} by ${t.by}  ${t.subject}`
}

export const tasks = (a: Ctx, o: Opts) => {
  const {views} = Room.tasks(a, {all: flag(o, 'all')})
  if (flag(o, 'json')) return dump(views)
  if (!views.length) return out(flag(o, 'all') ? 'no work' : `no open work (profile ${a.R.profile.name}; tasks --all for everything)`)
  for (const t of views) out(taskLine(t))
}

export const log = (a: Ctx, o: Opts) => {
  const msgs = Room.log(a, {agent: opt(o, 'agent'), all: flag(o, 'all'), n: Number(opt(o, 'n') ?? 20)})
  if (flag(o, 'json')) return dump(msgs.map(asJson))
  for (const m of msgs) out(oneLine(m))
}
