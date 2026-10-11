// room: what any participant (the operator or an agent) does in a room: write messages and read them, follow work,
// check signals. Each operation takes who acts and typed input, and returns data; interfaces print it.

import fs from 'node:fs'
import * as D from '../domain/decisions.ts'
import {isOpen, tasksIn} from '../domain/profiles.ts'
import type {Task} from '../domain/profiles.ts'
import * as Signals from '../domain/signals.ts'
import {OPERATOR} from '../home/index.ts'
import {HIDDEN, append} from '../hub/index.ts'
import type {Room} from '../hub/index.ts'
import * as HubSignals from '../hub/signals.ts'
import {fail, note, short} from '../lib/index.ts'
import {checkCollisions} from '../protocol/files.ts'
import type {Entry} from '../protocol/files.ts'
import {ID_RE, TOKEN_RE, checkOutgoing, compose, link, lookup, ordered, rootOf, under} from '../protocol/index.ts'
import type {All, Message} from '../protocol/index.ts'
import {linked, loadRoomUnlocked, loadState, readerLock, saveState} from '../runtime/reader.ts'
import type {Staged} from '../runtime/reader.ts'
import {taskView} from './view.ts'
import type {TaskView} from './view.ts'

// Who acts, and in which room.
export type Actor = {R: Room, me: string}
export const isRef = (R: Room) => (x: string): boolean => R.hub.store.isRef(x)

// --- writing ---

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
// Staging, like git's index: add takes a file's content into the store now, and the actor's next message carries it,
// whatever happens to the file meanwhile. Results and state travel only so, never through a shared directory. The store
// keeps staged contents reachable (`retain`); it grows before the list does and shrinks after, so a crash in between
// leaks an object rather than loses one.
export const FILE_MAX = 64 << 20
const tooBig = (path: string, size: number) => size > FILE_MAX && fail(`${path} is ${Math.ceil(size / (1 << 20))} MiB; an attachment is at most ${FILE_MAX >> 20} MiB`)
// What retain keeps: each staged content once, named by its id, so two snapshots of one path both stay.
const kept = (all: Staged[]): Entry[] => [...new Set(all.map(s => s.blob))].map(blob => ({path: blob, blob, mode: '100644'}))
export const staged = ({R, me}: Actor): Staged[] => loadState(R, me).staged ?? []
export const stage = ({R, me}: Actor, files: Entry[]): Staged[] => {
  const taken = files.map(e => {
    if (!e.file) fail(`${e.path}: add takes files`)
    tooBig(e.path, fs.statSync(e.file!).size)
    const b = R.hub.store.blob(e.file!)
    tooBig(e.path, b.size)
    return {path: e.path, blob: b.id, mode: e.mode, size: b.size}
  })
  return readerLock(R, me, () => {
    const st = loadState(R, me)
    const next = new Map((st.staged ?? []).map(s => [s.path, s]))
    for (const s of taken) next.set(s.path, s)
    const all = [...next.values()]
    checkCollisions(all.map(s => s.path))
    R.hub.store.retain(R.s, me, kept([...all, ...st.staged ?? []]))
    saveState(R, me, {...st, staged: all})
    R.hub.store.retain(R.s, me, kept(all))
    return all
  })
}
const shrink = ({R, me}: Actor, keep: (s: Staged) => boolean): Staged[] => {
  const st = loadState(R, me)
  const left = (st.staged ?? []).filter(keep)
  saveState(R, me, {...st, staged: left})
  R.hub.store.retain(R.s, me, kept(left))
  return left
}
// Unstages the given paths, or everything.
export const unstage = (a: Actor, paths: string[] | null): Staged[] => readerLock(a.R, a.me, () => {
  const missing = (paths ?? []).filter(p => !staged(a).some(s => s.path === p))
  if (missing.length) fail(`not staged: ${missing.join(', ')}`)
  return shrink(a, s => paths !== null && !paths.includes(s.path))
})
// A message from the actor. The operator may omit `to`: the room, or the assignees when there are any.
export const send = ({R, me}: Actor, x: SendInput): Sent => {
  const P = R.profile
  const {all} = linked(R, me)
  const re = x.re ? lookup(all, x.re) : null
  let to = [...new Set(x.to ?? [])]
  const assign = x.assign ? [...new Set(x.assign)] : null
  if (!to.length && x.reply && re) to = re.from === me ? re.to : [re.from, ...(x.all ? re.to.filter(t => t !== me) : [])]
  if (!to.length && assign) to = assign
  if (!to.length && me === OPERATOR) to = ['*']
  if (!to.length) fail('--to is required: agent ids, comma-separated, or *')
  for (const t of to) if (t !== '*' && !ID_RE.test(t)) fail(`bad recipient ${t}`)
  if (x.state && !P.states.includes(x.state)) fail(`--state must be one of profile ${P.name}: ${P.states.join(', ')}`)
  if (x.state && !re) fail('--state belongs to a reply inside a piece of work; pass --re <message>')
  for (const a of assign ?? []) if (!ID_RE.test(a)) fail(`bad assignee ${a}`)
  if (x.roles && !x.roles.split(',').every(r => {
    const parts = r.split('=').map(v => v.trim())
    return parts.length === 2 && ID_RE.test(parts[0]) && TOKEN_RE.test(parts[1])
  })) fail('--roles takes "<id>=<label>, …"; labels mean what the room profile says')
  let grant: string | null = null
  if (x.grant) {
    const d = lookup(all, x.grant)
    const g = D.grantOf(all, R.authorityAt, d.id) ?? fail(`${short(d.id)} is not an approved decision with a budget`)
    if (g.revoked) fail(`grant ${short(g.id)} was revoked`)
    grant = g.id
  }
  // What the actor staged goes along, an explicit attachment of the same path in its place.
  const stagedNow = staged({R, me}), explicit = x.files ?? []
  for (const e of explicit) if (e.file) tooBig(e.path, fs.statSync(e.file).size)
  const named = new Set(explicit.map(e => e.path))
  const entries: Entry[] = [...stagedNow.filter(s => !named.has(s.path)).map(s => ({path: s.path, blob: s.blob, mode: s.mode})), ...explicit]
  checkCollisions(entries.map(e => e.path))
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

// --- reading ---

// Who marked a message how (read, taken), from the marks that pass their check.
export const marks = (R: Room, all: All): Map<string, Record<string, string[]>> => Signals.marksOn(Signals.check(R, all, R.hub.store.signals(R.s)))
export const message = ({R, me}: Actor, ref: string): {all: All, m: Message, replies: Message[], marks: Record<string, string[]> | undefined} => {
  const {all} = linked(R, me)
  const m = lookup(all, ref)
  return {all, m, replies: [...all.values()].filter(x => x.reId === m.id), marks: marks(R, all).get(m.id)}
}
export const thread = ({R, me}: Actor, ref: string): {all: All, msgs: Message[]} => {
  const {all} = linked(R, me)
  return {all, msgs: under(all, rootOf(all, lookup(all, ref)))}
}
// Open work that concerns the actor (the operator: all open work); with `all`, every piece of work.
export const tasks = ({R, me}: Actor, {all: everything = false}: {all?: boolean} = {}): {tasks: Task[], views: TaskView[]} => {
  const P = R.profile
  const {all} = linked(R, me)
  let ts = tasksIn(all, P)
  if (!everything) ts = ts.filter(t => isOpen(t, P) && (me === OPERATOR || t.requester === me || t.assignees.includes(me) || (!t.assignees.length && (t.root.to.includes(me) || t.root.to.includes('*')))))
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
  return {m, files: m.files.filter(f => !path || f.path === path).map(f => ({path: f.path, content: R.hub.store.file(m.id, f.path)}))}
}
export type MemberView = {id: string, role: string, messages: number, card: string | null}
export const members = ({R, me}: Actor): MemberView[] => {
  const {logs, all} = linked(R, me)
  const cards = new Map(ordered([...all.values()].filter(m => m.kind === 'card' && !m.bad)).map(m => [m.from, m]))
  return Object.entries(R.members).map(([id, info]) => ({id, role: info.role ?? 'member',
    messages: (logs.get(id) ?? []).filter(m => !(m.kind && HIDDEN.has(m.kind))).length, card: cards.get(id)?.subject ?? null}))
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
    const records = R.hub.store.signals(R.s)
    const checked = Signals.check(R, all, records)
    const p = Signals.pins(records, checked, st.signals)
    saveState(R, me, {...loadState(R, me), signals: p.accepted})
    return {all, checked, alarms: [...p.alarms, ...checked.filter(c => !c.ok).map(c => `signal ${c.ref}: ${c.why}`)], repaired}
  })

// What interfaces need to show and store a message's files: their sizes, and a path safe to write under.
export {withSizes} from '../hub/index.ts'
export {checkPath} from '../protocol/files.ts'
