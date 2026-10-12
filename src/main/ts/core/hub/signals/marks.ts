// marks: where attention is — `read` on delivery, `taken` on demand — possible or not, and who put which on what.

import {HIDDEN, visible} from '../protocol/index.ts'
import type {Message} from '../protocol/index.ts'
import {MARKS} from './model.ts'
import type {Checked, RoomModel} from './model.ts'

// Why each mark cannot be put on this message, or nothing when it can.
const RULES: Record<string, (R: RoomModel, actor: string, m: Message) => string | undefined> = {
  read: (_R, actor, m) => {
    if (m.from === actor) return 'one does not read one\'s own message'
    return visible(m, actor, HIDDEN) ? undefined : `the message is not delivered to ${actor}`
  },
  taken: (R, _actor, m) => m.kind !== R.profile.opens || m.bad ? `the message does not open work (${R.profile.opens})` : undefined,
}
// Why the actor cannot put this mark on this message, or nothing when it can.
export const markWhy = (R: RoomModel, actor: string, m: Message, mark: string): string | undefined => {
  if (!R.members[actor]) return `${actor} is not a member of ${R.name}`
  const rule = RULES[mark]
  return rule ? rule(R, actor, m) : `unknown mark ${mark}`
}
// The marks on each message that passed the check: target → mark → actors.
export const marksOn = (checked: Checked[]): Map<string, Record<string, string[]>> => {
  const by = new Map<string, Record<string, string[]>>()
  for (const c of checked.filter(c => c.ok && MARKS.includes(c.signal))) {
    const e = by.get(c.target) ?? {}
    ;(e[c.signal] ??= []).push(c.actor)
    by.set(c.target, e)
  }
  return by
}
