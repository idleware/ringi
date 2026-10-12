import {isOpen, taskOf} from '../../hub/work/index.ts'
import type {Room} from '../../hub/rooms/index.ts'
import {OPERATOR, append} from '../../hub/rooms/index.ts'
import type {All} from '../../hub/protocol/index.ts'
import {compose} from '../../hub/protocol/index.ts'
import type {Group, Planning, Reserve, WatchContext} from './types.ts'

export const reportExhausted = ({c, R, all, grp, r, p}: {c: WatchContext, R: Room, all: All, grp: Group, r: Reserve, p: Planning}): void => {
  const key = `${grp.task?.id}/${grp.grant}`
  if (!r.exhausted || !grp.task || p.exhausted[key]) return
  p.exhausted[key] = true
  const t = taskOf(all, grp.task, R.profile), last = grp.msgs.at(-1)!
  if (isOpen(t, R.profile)) append(R, c.me, compose(`${r.why}; waiting for a new grant`, [
    ['To', [...new Set([t.requester, OPERATOR])].join(', ')], ['Re', last.id], ['State', R.profile.waiting], ['Hop', String(last.hopEff + 1)]]))
}
