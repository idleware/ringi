// profile: what a task is, as data. ringi is a point of coordination, not a methodology: the states of a piece of
// work, which of them end it, and who may move it, assign it or label people in it are declared by a profile
// that lives in the hub (`profiles/<name>.json` on main) and is chosen per room. The A2A task model is one such
// profile (resources/profiles/a2a-1.json); a team or a framework brings its own (architect, reviewer, tester, …).
// This file interprets any profile; it knows no state, role or rule by name.

import {HEARTBEATS, ID_RE, TOKEN_RE, one, ordered} from '../protocol/index.ts'
import type {All, Message} from '../protocol/index.ts'
import {fail, strictJson} from '../lib/index.ts'

export const PROFILE_SCHEMA = 'ringi-profile/1'
export const DEFAULT_PROFILE = 'a2a-1'
// A hub whose rooms may follow profiles other than the built-in A2A rules declares this capability, so that an older
// client, which knows only those rules, refuses it instead of misreading it.
export const PROFILES_CAPABILITY = 'profiles/1'

// A rule lists principals: `requester` (who opened the work), `assignee`, `member` (anyone in the room),
// `role:<label>` (whoever holds that label in the work), or `agent:<id>`. An empty or missing rule allows nobody;
// an exact `state:<s>` rule replaces `state:*` for that state.
export type Rules = {assign?: string[], roles?: string[], grant?: string[], [state: `state:${string}`]: string[] | undefined}
export type Profile = {
  schema: typeof PROFILE_SCHEMA
  name: string
  description?: string
  opens: string
  states: string[]
  initial: string
  terminal: string[]
  // The state a runner sets when the work cannot go on without input or budget; none if the profile has no such state.
  waiting?: string
  rules: Rules
}
export type Task = {
  root: Message
  msgs: Message[]
  state: string
  by: string
  at: number
  requester: string
  assignees: string[]
  roles: Record<string, string>
  // The grant the work spends (decisions/1): its root's `Grant`, replaced by a later one from whoever the `grant`
  // rule allows (a top-up).
  grant: string | null
  // What each message actually changed, in fold order: `opened`, `assigned`, `roles`, `grant`, `state.<s>`. A trailer
  // the author had no right to is not here; signals (signals.ts) are made only from these.
  effects: Map<string, string[]>
}

const PRINCIPAL_RE = /^(?:requester|assignee|member|role:[a-z][a-z0-9-]*|agent:[a-z0-9]+(?:[._-][a-z0-9]+)*)$/
// A profile is refused, not guessed at, when it is not exactly what this schema describes.
export const parseProfile = (text: string, label: string): Profile => {
  const p = strictJson<Profile>(text, label)
  const bad = (why: string): never => fail(`${label}: ${why}`)
  if (p.schema !== PROFILE_SCHEMA) bad(`schema ${String(p.schema)} is not ${PROFILE_SCHEMA}; upgrade ringi or fix the profile`)
  if (!ID_RE.test(p.name ?? '')) bad('a profile needs a name like team-flow-1')
  if (!TOKEN_RE.test(p.opens ?? '')) bad('`opens` names the Kind that opens a piece of work')
  if (!Array.isArray(p.states) || !p.states.length || !p.states.every(s => TOKEN_RE.test(s)) || new Set(p.states).size !== p.states.length) bad('`states` must be distinct tokens')
  if (!p.states.includes(p.initial)) bad('`initial` must be one of the states')
  if (!Array.isArray(p.terminal) || !p.terminal.every(s => p.states.includes(s))) bad('`terminal` must list states')
  if (p.waiting !== undefined && (!p.states.includes(p.waiting) || p.terminal.includes(p.waiting))) bad('`waiting` must be a state that does not end the work')
  if (!p.rules || typeof p.rules !== 'object') bad('`rules` is required')
  for (const [k, v] of Object.entries(p.rules)) {
    if (!/^(?:assign|roles|grant|state:(?:\*|[a-z][a-z0-9-]*))$/.test(k)) bad(`unknown rule ${k}`)
    if (k.startsWith('state:') && k !== 'state:*' && !p.states.includes(k.slice(6))) bad(`rule ${k} names an unknown state`)
    if (!Array.isArray(v) || v.length > 64 || !v.every(x => PRINCIPAL_RE.test(x))) bad(`rule ${k} must list principals: requester, assignee, member, role:<label>, agent:<id>`)
  }
  return p
}

const allows = (rule: string[] | undefined, who: string, t: Task): boolean => !!rule?.some(p =>
  p === 'requester' ? who === t.requester
    : p === 'assignee' ? t.assignees.includes(who)
      : p === 'member' ? true
        : p.startsWith('role:') ? t.roles[who] === p.slice(5)
          : p === `agent:${who}`)
export const ruleFor = (profile: Profile, state: string): string[] | undefined => profile.rules[`state:${state}`] ?? profile.rules['state:*']

// A message belongs to the nearest work item on its Re chain, itself included.
export const taskFor = (all: All, m: Message, profile: Profile): Message | null => {
  for (let x: Message | undefined = m, i = 0; x && i < 100000; x = x.reId ? all.get(x.reId) : undefined, i++) if (x.kind === profile.opens && !x.bad) return x
  return null
}
// A work item folds over its messages in thread order. Every right is judged on the work as it was before the
// message, so a label given in a message authorizes nothing in that same message, while its holder may still hand it
// over and reassign in one reply. Opening sets the initial state and assignees (Assign, else To minus the opener; none
// for To: *). The first terminal state is final; assignment and labels may still change after it.
export const taskOf = (all: All, root: Message, profile: Profile): Task => {
  // Heartbeats never take part in work (§6), whatever trailers they carry.
  const msgs = ordered([...all.values()].filter(m => !m.bad && !(m.kind && HEARTBEATS.has(m.kind)) && taskFor(all, m, profile) === root))
  const t: Task = {root, msgs, state: profile.initial, by: root.from, at: root.time, requester: root.from, roles: {...root.roles},
    assignees: root.assign ?? (root.to.includes('*') ? [] : root.to.filter(x => x !== root.from)), grant: one(root, 'grant'), effects: new Map()}
  t.effects.set(root.id, ['opened', ...(root.assign ? ['assigned'] : [])])
  for (const m of msgs) {
    if (m === root) continue
    const before: Task = {...t, roles: {...t.roles}, assignees: [...t.assignees]}
    const fx: string[] = []
    if (one(m, 'grant') && allows(profile.rules.grant, m.from, before)) {
      t.grant = one(m, 'grant')
      fx.push('grant')
    }
    if (m.roles && allows(profile.rules.roles, m.from, before)) {
      for (const [id, label] of Object.entries(m.roles)) label === 'none' ? delete t.roles[id] : t.roles[id] = label
      fx.push('roles')
    }
    if (m.assign && allows(profile.rules.assign, m.from, before)) {
      t.assignees = m.assign
      fx.push('assigned')
    }
    if (m.state && !profile.terminal.includes(t.state) && profile.states.includes(m.state) && allows(ruleFor(profile, m.state), m.from, before)) {
      Object.assign(t, {state: m.state, by: m.from, at: m.time})
      fx.push(`state.${m.state}`)
    }
    if (fx.length) t.effects.set(m.id, fx)
  }
  return t
}
export const tasksIn = (all: All, profile: Profile): Task[] => [...all.values()].filter(m => m.kind === profile.opens && !m.bad).map(r => taskOf(all, r, profile))
export const isOpen = (t: Task, profile: Profile): boolean => !profile.terminal.includes(t.state)
