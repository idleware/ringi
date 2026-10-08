// signals: explicit markers of what happens in a room, beside the messages that carry it. Every effective transition
// (work opened, assigned, a state reached, a proposal, a counted stamp, the decision, a counted usage receipt) is also
// a signal in its author's own namespace under the room's genesis, pointing at the message that made it: in a git
// store an annotated tag `ringi/<genesis>/<author>/<message>.<signal>`, signed on a signed hub. Signals are visible
// and checkable with the store's own tools (`git tag -v`, a forge's tag list and tag-push webhooks) and cheap to poll.
//
// The messages stay the truth. A signal is made only for a transition the fold actually counted (a State the author
// had no right to makes none). A reader checks every signal against its message and pins the stored object it
// accepted; a signal that disagrees, or an accepted one that changes or disappears, is an alarm. A signal missing
// after a crash between message and tag changes nothing and is restored with `signals --repair`.
//
// Marks are the second layer, in the same namespace: where attention is, not what was decided. `read` says a message
// reached its reader (made on delivery); `taken` says a member took a piece of work. A mark changes no state,
// assignment or budget. It is checked only for being possible: its target is an accepted message of the room, its
// actor a member; `read` only for a message addressed to the actor or to all, `taken` only for a message that opens
// work.

import * as D from './decisions.ts'
import {taskFor, taskOf} from './profiles.ts'
import type {Profile} from './profiles.ts'
import {HIDDEN, one, visible} from '../protocol/index.ts'
import type {All, Message} from '../protocol/index.ts'
// What the folds need of a room; a hub's Room is one.
export type RoomModel = {name: string, genesis: string, profile: Profile, members: Record<string, unknown>, authorityAt: D.AuthorityAt}
// A stored signal as a store returns it: an annotated tag (git) or its equivalent.
export type SignalRecord = {ref: string, object: string, name: string, actor: string, target: string, tagger: string, text: string}

export const MARKS = ['read', 'taken']
// The canonical text of a signal or mark: what its author stores and every reader compares.
export const signalBody = (R: Pick<RoomModel, 'name' | 'genesis'>, who: string, id: string, signal: string): string =>
  `${signal}\n\nRoom: ${R.name}\nGenesis: ${R.genesis}\nActor: ${who}\nMessage: ${id}\nSignal: ${signal}\n`
// Why the actor cannot put this mark on this message, or nothing when it can.
export const markWhy = (R: RoomModel, actor: string, m: Message, mark: string): string | undefined =>
  !R.members[actor] ? `${actor} is not a member of ${R.name}`
    : mark === 'read' ? (m.from === actor ? 'one does not read one\'s own message' : !visible(m, actor, HIDDEN) ? `the message is not delivered to ${actor}` : undefined)
      : mark === 'taken' ? (m.kind !== R.profile.opens || m.bad ? `the message does not open work (${R.profile.opens})` : undefined)
        : `unknown mark ${mark}`
// The marks on each message that passed the check: target → mark → actors.
export const marksOn = (checked: Checked[]): Map<string, Record<string, string[]>> => {
  const by = new Map<string, Record<string, string[]>>()
  for (const c of checked) {
    if (!c.ok || !MARKS.includes(c.signal)) continue
    const e = by.get(c.target) ?? {}
    ;(e[c.signal] ??= []).push(c.actor)
    by.set(c.target, e)
  }
  return by
}

// The signals a message made, judged on the room as it is now (thread order is fixed, so this does not change).
export const effective = (R: RoomModel, all: All, m: Message): string[] => {
  if (m.bad || m.invalid) return []
  const s: string[] = []
  const work = taskFor(all, m, R.profile)
  if (work) for (const fx of taskOf(all, work, R.profile).effects.get(m.id) ?? []) if (fx === 'opened' || fx === 'assigned' || fx.startsWith('state.')) s.push(fx)
  if (m.kind === 'proposal') s.push('proposed')
  if (m.kind === 'usage' && D.counted(all, R.authorityAt, m)) s.push(`usage.${one(m, 'usage')}`)
  const p = m.reId ? all.get(m.reId) : undefined
  if (p?.kind === 'proposal' && !p.bad) {
    const info = D.proposalOf(all, p, R.authorityAt)
    if (m.kind === 'stamp' && info.reviewers.includes(m.from)) s.push(`stamp.${one(m, 'stamp')}`)
    if (m.kind === 'decision' && info.decision?.id === m.id) s.push(`decision.${info.decision.decision}`)
    if (m.kind === 'decision' && info.revoked?.id === m.id) s.push('decision.revoked')
  }
  return s
}
export type Checked = {ref: string, actor: string, signal: string, target: string, ok: boolean, why?: string}
// A signal holds when its author made it, it is named after and points at a message of its author in this room, and
// that message made exactly this signal.
export const check = (R: RoomModel, all: All, records: SignalRecord[]): Checked[] => records.map(x => {
  const dot = x.name.indexOf('.')
  const id = x.name.slice(0, dot)
  const signal = x.name.slice(dot + 1)
  const m = all.get(x.target)
  const what = (): string | undefined => {
    if (!x.target) return 'is not an annotated tag on a message'
    if (x.tagger !== x.actor) return `was made by ${x.tagger}, not ${x.actor}`
    if (id !== x.target) return 'is named after another message'
    if (!m) return 'points at no accepted message of this room'
    if (MARKS.includes(signal)) {
      const why = markWhy(R, x.actor, m, signal)
      if (why) return why
    } else {
      if (m.from !== x.actor) return `points at a message of ${m.from}`
      if (!effective(R, all, m).includes(signal)) return `its message did not make ${signal}`
    }
    // Signals and marks alike carry exactly their canonical body (a signed one, its signature after it).
    if (x.text.split('-----BEGIN SSH SIGNATURE-----')[0].trimEnd() !== signalBody({...R, name: R.name.split('@')[0]}, x.actor, x.target, signal).trimEnd()) return 'its trailers disagree with the signal'
    return undefined
  }
  const why = what()
  return {ref: x.ref, actor: x.actor, signal, target: x.target, ok: !why, why}
})
// A signal's identity in any store and after an archive: `<actor>/<message>.<signal>`, the last two components of its
// ref; pins an older reader kept under a full ref read the same way.
const keyOf = (ref: string): string => ref.split('/').slice(-2).join('/')
// A reader's pins: the stored object of each signal it accepted. A changed or vanished one is an alarm.
export const pins = (records: SignalRecord[], checked: Checked[], accepted: Record<string, string> = {}): {accepted: Record<string, string>, alarms: string[]} => {
  const now = new Map(records.map(x => [`${x.actor}/${x.name}`, x]))
  const alarms: string[] = []
  const next: Record<string, string> = {}
  for (const [k, object] of Object.entries(accepted)) {
    const key = keyOf(k), x = now.get(key)
    // Two old pins of one signal (its live and its archived ref) that disagree: keep the first as accepted and the
    // other under its own ref as evidence, so the conflict is reported on every read until it is resolved.
    if (key in next && next[key] !== object) {
      alarms.push(`signal ${key} has two different accepted objects (${next[key]} and ${object})`)
      next[k] = object
      continue
    }
    next[key] = object
    if (!x) alarms.push(`signal ${key} was removed after it was accepted`)
    else if (x.object !== object) alarms.push(`signal ${x.ref} was replaced after it was accepted`)
  }
  for (const c of checked) if (c.ok && !next[keyOf(c.ref)]) next[keyOf(c.ref)] = now.get(keyOf(c.ref))!.object
  return {accepted: next, alarms}
}
