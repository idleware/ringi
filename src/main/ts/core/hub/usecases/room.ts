// room: what any participant (the operator or an agent) does in a room: write messages and read them, follow work,
// check signals. Each operation takes who acts and typed input, and returns data; interfaces print it.

import * as Signals from '../signals/index.ts'
import {isOpen, tasksIn} from '../work/index.ts'
import type {Task} from '../work/index.ts'
import {HIDDEN, OPERATOR} from '../rooms/index.ts'
import type {Room} from '../rooms/index.ts'
import * as HubSignals from '../signals/write.ts'
import {fail, short} from '../../../lib/index.ts'
import {link, lookup, ordered, rootOf, under} from '../protocol/index.ts'
import type {All, Message} from '../protocol/index.ts'
import {linked, loadRoomUnlocked, loadState, readerLock, saveState} from '../history/index.ts'
import type {Actor} from './actor.ts'
import {taskView} from './view.ts'
import type {TaskView} from './view.ts'

export * from './actor.ts'
export * from './send.ts'

// --- reading ---

// Who marked a message how (read, taken), from the marks that pass their check.
export const marks = (R: Room, all: All): Map<string, Record<string, string[]>> => Signals.marksOn(Signals.check(R, all, R.store.signals(R.s)))
export const message = ({R, me}: Actor, ref: string): {all: All, m: Message, replies: Message[], marks: Record<string, string[]> | undefined} => {
  const {all} = linked(R, me)
  const m = lookup(all, ref)
  return {all, m, replies: [...all.values()].filter(x => x.reId === m.id), marks: marks(R, all).get(m.id)}
}
export const thread = ({R, me}: Actor, ref: string): {all: All, msgs: Message[]} => {
  const {all} = linked(R, me)
  return {all, msgs: under(all, rootOf(all, lookup(all, ref)))}
}
// Work concerns the operator, its requester and assignees, and, while nobody is assigned, whom its root names.
const concerns = (t: Task, me: string): boolean => {
  if (me === OPERATOR || t.requester === me || t.assignees.includes(me)) return true
  return !t.assignees.length && (t.root.to.includes(me) || t.root.to.includes('*'))
}
// Open work that concerns the actor (the operator: all open work); with `all`, every piece of work.
export const tasks = ({R, me}: Actor, {all: everything = false}: {all?: boolean} = {}): {tasks: Task[], views: TaskView[]} => {
  const P = R.profile
  const {all} = linked(R, me)
  let ts = tasksIn(all, P)
  if (!everything) ts = ts.filter(t => isOpen(t, P) && concerns(t, me))
  ts.sort((a, b) => a.at - b.at)
  const m = marks(R, all)
  return {tasks: ts, views: ts.map(t => taskView(t, m.get(t.root.id)?.taken ?? []))}
}
export const log = ({R, me}: Actor, {agent, all: everything = false, n = 20}: {agent?: string, all?: boolean, n?: number} = {}): Message[] => {
  const {all} = linked(R, me)
  return ordered([...all.values()].filter(m => (!agent || m.from === agent) && (everything || !(m.kind && HIDDEN.has(m.kind))))).slice(-n)
}
// The files of a message: one named path, or all of them.
export const files = ({R, me}: Actor, ref: string, path?: string): {m: Message, files: Array<{path: string, content: Buffer}>} => {
  const {all} = linked(R, me)
  const m = lookup(all, ref)
  if (path && !m.files.some(f => f.path === path)) fail(`no ${path} in ${short(m.id)}`)
  return {m, files: m.files.filter(f => !path || f.path === path).map(f => ({path: f.path, content: R.store.file(m.id, f.path)}))}
}
export type MemberView = {id: string, role: string, messages: number}
export const members = ({R, me}: Actor): MemberView[] => {
  const {logs} = linked(R, me)
  return Object.entries(R.members).map(([id, info]) => ({id, role: info.role ?? 'member',
    messages: (logs.get(id) ?? []).filter(m => !(m.kind && HIDDEN.has(m.kind))).length}))
}

// --- signals ---

// The room's signals, each checked against its message and against what this reader accepted before; `repair` first
// restores the missing signals of the actor's own messages.
export const signals = ({R, me}: Actor, {repair = false}: {repair?: boolean} = {}): {all: All, checked: Signals.Checked[], alarms: string[], repaired: number | null} =>
  readerLock(R, me, () => {
    const {logs, st} = loadRoomUnlocked(R, me)
    const all = link(logs)
    let repaired: number | null = null
    if (repair) {
      repaired = 0
      for (const m of logs.get(me) ?? []) repaired += HubSignals.emit(R, me, all, m)
    }
    const records = R.store.signals(R.s)
    const checked = Signals.check(R, all, records)
    const p = Signals.pins(records, checked, st.signals)
    saveState(R, me, {...loadState(R, me), signals: p.accepted})
    return {all, checked, alarms: [...p.alarms, ...checked.filter(c => !c.ok && !c.pending).map(c => `signal ${c.actor} ${c.signal} ${short(c.ref)}: ${c.why}`)], repaired}
  })

// What interfaces need to show and store a message's files: their sizes, and a path safe to write under.
export {withSizes} from '../rooms/index.ts'
export {checkPath} from '../protocol/files.ts'
