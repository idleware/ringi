// task: a piece of work folded over its messages in thread order, by the room's profile.

import {HEARTBEATS, one, ordered} from '../protocol/index.ts'
import type {All, Message} from '../protocol/index.ts'
import type {Profile, Task} from './index.ts'

// Who a principal of a rule is in a piece of work.
const PRINCIPALS: Record<string, (who: string, t: Task) => boolean> = {
  requester: (who, t) => who === t.requester,
  assignee: (who, t) => t.assignees.includes(who),
  member: () => true,
}
const holds = (p: string, who: string, t: Task): boolean =>
  PRINCIPALS[p]?.(who, t) ?? (p.startsWith('role:') ? t.roles[who] === p.slice(5) : p === `agent:${who}`)
const allows = (rule: string[] | undefined, who: string, t: Task): boolean => !!rule?.some(p => holds(p, who, t))
const ruleFor = (profile: Profile, state: string): string[] | undefined => profile.rules[`state:${state}`] ?? profile.rules['state:*']

// A message belongs to the nearest work item on its Re chain, itself included.
export const taskFor = (all: All, m: Message, profile: Profile): Message | null => {
  for (let x: Message | undefined = m, i = 0; x && i < 100000; x = x.reId ? all.get(x.reId) : undefined, i++) if (x.kind === profile.opens && !x.bad) return x
  return null
}

// One kind of change a message may make, judged on the work as it was before the message (`b`); its effect, or null.
type Step = (profile: Profile, t: Task, b: Task, m: Message) => string | null
const grant: Step = (profile, t, b, m) => {
  if (!one(m, 'grant') || !allows(profile.rules.grant, m.from, b)) return null
  t.grant = one(m, 'grant')
  return 'grant'
}
const roles: Step = (profile, t, b, m) => {
  if (!m.roles || !allows(profile.rules.roles, m.from, b)) return null
  for (const [id, label] of Object.entries(m.roles)) label === 'none' ? delete t.roles[id] : t.roles[id] = label
  return 'roles'
}
const assign: Step = (profile, t, b, m) => {
  if (!m.assign || !allows(profile.rules.assign, m.from, b)) return null
  t.assignees = m.assign
  return 'assigned'
}
// The first terminal state is final.
const movable = (profile: Profile, t: Task, s: string | null): s is string => !!s && !profile.terminal.includes(t.state) && profile.states.includes(s)
const state: Step = (profile, t, b, m) => {
  if (!movable(profile, t, m.state) || !allows(ruleFor(profile, m.state), m.from, b)) return null
  Object.assign(t, {state: m.state, by: m.from, at: m.time})
  return `state.${m.state}`
}
const STEPS = [grant, roles, assign, state]

const opening = (root: Message, profile: Profile, msgs: Message[]): Task => ({root, msgs, state: profile.initial, by: root.from, at: root.time,
  requester: root.from, roles: {...root.roles}, assignees: root.assign ?? (root.to.includes('*') ? [] : root.to.filter(x => x !== root.from)),
  grant: one(root, 'grant'), effects: new Map([[root.id, ['opened', ...(root.assign ? ['assigned'] : [])]]])})
// Heartbeats never take part in work (§6), whatever trailers they carry.
const partOf = (all: All, m: Message, root: Message, profile: Profile): boolean =>
  !m.bad && !(m.kind && HEARTBEATS.has(m.kind)) && taskFor(all, m, profile) === root
// A work item folds over its messages in thread order. Every right is judged on the work as it was before the
// message, so a label given in a message authorizes nothing in that same message, while its holder may still hand it
// over and reassign in one reply. Opening sets the initial state and assignees (Assign, else To minus the opener; none
// for To: *). The first terminal state is final; assignment and labels may still change after it.
export const taskOf = (all: All, root: Message, profile: Profile): Task => {
  const t = opening(root, profile, ordered([...all.values()].filter(m => partOf(all, m, root, profile))))
  for (const m of t.msgs.filter(m => m !== root)) {
    const before: Task = {...t, roles: {...t.roles}, assignees: [...t.assignees]}
    const fx = STEPS.map(step => step(profile, t, before, m)).filter((x): x is string => !!x)
    if (fx.length) t.effects.set(m.id, fx)
  }
  return t
}
export const tasksIn = (all: All, profile: Profile): Task[] => [...all.values()].filter(m => m.kind === profile.opens && !m.bad).map(r => taskOf(all, r, profile))
export const isOpen = (t: Task, profile: Profile): boolean => !profile.terminal.includes(t.state)
