// send: a message from the actor, its recipients, trailers and files checked before it is written.

import * as D from '../decisions/index.ts'
import type {Profile} from '../work/index.ts'
import {OPERATOR, append} from '../rooms/index.ts'
import type {Room} from '../rooms/index.ts'
import {fail, note, short} from '../../../lib/index.ts'
import type {Entry} from '../protocol/files.ts'
import {ID_RE, TOKEN_RE, checkOutgoing, compose, lookup} from '../protocol/index.ts'
import type {All, Message} from '../protocol/index.ts'
import {linked, readerLock} from '../history/index.ts'
import {isRef} from './actor.ts'
import type {Actor} from './actor.ts'
import {outgoing, shrink, staged} from './staging.ts'

export type SendInput = {
  text: string
  to?: string[]
  re?: string
  // A reply: without `to`, it goes back to the sender (with `all`, to everyone the message named).
  reply?: boolean
  all?: boolean
  task?: boolean
  state?: string
  assign?: string[]
  roles?: string
  grant?: string
  files?: Entry[]
}
export type Sent = {id: string, to: string[], files: number}

// A reply without `to` goes back to the sender (with `all`, to everyone the message named); one's own, to its recipients.
const replyTo = (me: string, x: SendInput, re: Message | null): string[] => {
  if (!x.reply || !re) return []
  if (re.from === me) return re.to
  return [re.from, ...(x.all ? re.to.filter(t => t !== me) : [])]
}
// Without `to`: a reply goes back, an assignment to the assignees, the operator's message to the room.
const recipients = (me: string, x: SendInput, re: Message | null, assign: string[] | null): string[] => {
  const to = [...new Set(x.to ?? [])]
  if (to.length) return to
  const back = replyTo(me, x, re)
  if (back.length) return back
  if (assign) return assign
  return me === OPERATOR ? ['*'] : fail('--to is required: agent ids, comma-separated, or *')
}
const role = (r: string): boolean => {
  const parts = r.split('=').map(v => v.trim())
  return parts.length === 2 && ID_RE.test(parts[0]) && TOKEN_RE.test(parts[1])
}
const checkTrailers = (P: Profile, x: SendInput, to: string[], assign: string[] | null, re: Message | null): void => {
  for (const t of to) if (t !== '*' && !ID_RE.test(t)) fail(`bad recipient ${t}`)
  if (x.state && !P.states.includes(x.state)) fail(`--state must be one of profile ${P.name}: ${P.states.join(', ')}`)
  if (x.state && !re) fail('--state belongs to a reply inside a piece of work; pass --re <message>')
  for (const a of assign ?? []) if (!ID_RE.test(a)) fail(`bad assignee ${a}`)
  if (x.roles && !x.roles.split(',').every(role)) fail('--roles takes "<id>=<label>, …"; labels mean what the room profile says')
}
// The grant a piece of work spends: an approved decision with a budget, not revoked.
const grantOf = (R: Room, all: All, ref: string | undefined): string | null => {
  if (!ref) return null
  const d = lookup(all, ref)
  const g = D.grantOf(all, R.authorityAt, d.id) ?? fail(`${short(d.id)} is not an approved decision with a budget`)
  return g.revoked ? fail(`grant ${short(g.id)} was revoked`) : g.id
}
// A message from the actor. The operator may omit `to`: the room, or the assignees when there are any.
export const send = ({R, me}: Actor, x: SendInput): Sent => {
  const P = R.profile
  const {all} = linked(R, me)
  const re = x.re ? lookup(all, x.re) : null
  const assign = x.assign ? [...new Set(x.assign)] : null
  const to = recipients(me, x, re, assign)
  checkTrailers(P, x, to, assign, re)
  const grant = grantOf(R, all, x.grant)
  const stagedNow = staged({R, me})
  const entries = outgoing(stagedNow, x.files ?? [])
  const text = compose(x.text, [
    ['To', to.join(', ')], ['Re', re?.id], ['Kind', x.task && P.opens], ['State', x.state], ['Assign', assign?.join(', ')],
    ['Roles', x.roles], ['Grant', grant], ['Hop', re && String(re.hopEff + 1)],
  ])
  checkOutgoing(text, isRef(R))
  const id = append(R, me, text, entries)
  if (stagedNow.length) readerLock(R, me, () => shrink({R, me}, s => !stagedNow.some(t => t.path === s.path && t.blob === s.blob)))
  if (to.length === 1 && to[0] === '*') note(`addressed to the whole room: this ${x.task ? P.opens : 'message'} wakes nobody; name recipients (--to or --assign) to start work`)
  return {id, to, files: entries.length}
}
