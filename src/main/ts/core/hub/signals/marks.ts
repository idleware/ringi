// marks: where attention is — `read` on delivery, `taken` on demand — possible or not, and who put which on what. A
// `read` is a reader's cursor in one author's log: it got every message of that log up to the marked one that was
// addressed to it, so a delivery marks only the last message of each log it reached.

import {HIDDEN, visible} from '../protocol/index.ts'
import type {All, Message} from '../protocol/index.ts'
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
// Each reader's cursor in each log: the furthest message its read marks reach.
const cursors = (all: All, reads: Checked[]): Map<string, Map<string, number>> => {
  const by = new Map<string, Map<string, number>>()
  for (const c of reads) {
    const t = all.get(c.target)
    if (!t) continue
    const logs = by.get(c.actor) ?? new Map<string, number>()
    logs.set(t.from, Math.max(logs.get(t.from) ?? -1, t.seq))
    by.set(c.actor, logs)
  }
  return by
}
// The marks on each message that passed the check: target → mark → actors; a message is read by each reader whose
// cursor in its log reaches it and to whom it was delivered.
export const marksOn = (R: RoomModel, all: All, checked: Checked[]): Map<string, Record<string, string[]>> => {
  const by = new Map<string, Record<string, string[]>>()
  const put = (target: string, mark: string, actor: string) => {
    const e = by.get(target) ?? {}
    ;(e[mark] ??= []).push(actor)
    by.set(target, e)
  }
  const ok = checked.filter(c => c.ok && MARKS.includes(c.signal))
  const reach = cursors(all, ok.filter(c => c.signal === 'read'))
  for (const m of all.values()) for (const [reader, logs] of reach)
    if ((logs.get(m.from) ?? -1) >= m.seq && !markWhy(R, reader, m, 'read')) put(m.id, 'read', reader)
  for (const c of ok.filter(c => c.signal !== 'read')) put(c.target, c.signal, c.actor)
  return by
}
