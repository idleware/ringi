// decide: the extension for decisions and budgets (capability `decisions/1`, docs/spec/decisions-1.md). A proposal circulates
// to named reviewers, who stamp it; only the named decider, holding authority from the hub's contract, decides. An
// approval that carries a budget is a grant; work spends against it, and the runner that starts model runs writes
// the usage receipts. Everything here is a pure fold over messages; nothing trusts a model's own report.

import {ID_RE, one, ordered} from '../protocol/index.ts'
import type {All, Message, Parsed} from '../protocol/index.ts'
import {fail} from '../lib/index.ts'

export const CAPABILITY = 'decisions/1'
export const ROOT = 'operator'
export const BUDGET_KEYS = ['runs', 'run-seconds', 'concurrency'] as const
export type Budget = {runs: number, 'run-seconds': number, concurrency: number}
export const STAMPS = ['approve', 'object', 'abstain']
export const DECISIONS = ['approved', 'rejected', 'revoked']
// Who may decide up to which budget: {"decide": {"<id>": {"runs": n, "run-seconds": n, "concurrency": n}}}.
export type Authority = {decide?: Record<string, Partial<Budget>>}
export type AuthorityAt = (control: string | null) => Authority | null

const ids = (v: string | null) => v === null ? [] : [...new Set(v.split(',').map(x => x.trim()).filter(Boolean))]

// `runs=5, run-seconds=600, concurrency=1`; undefined if malformed. `runs` is required: a budget without a run count
// bounds nothing; a zero run time or concurrency would disable the bound it names.
export const parseBudget = (s: string | null | undefined): Budget | null | undefined => {
  if (s === null || s === undefined) return null
  const b: Partial<Budget> = {}
  for (const part of String(s).split(',').map(x => x.trim()).filter(Boolean)) {
    const m = /^([a-z][a-z-]*)=(\d{1,9})$/.exec(part)
    if (!m || !(BUDGET_KEYS as readonly string[]).includes(m[1]) || m[1] in b) return undefined
    b[m[1] as keyof Budget] = Number(m[2])
  }
  if (!('runs' in b) || b['run-seconds'] === 0 || b.concurrency === 0) return undefined
  return {'run-seconds': 1800, concurrency: 1, ...b} as Budget
}
export const budgetText = (b: Budget): string => BUDGET_KEYS.map(k => `${k}=${b[k]}`).join(', ')
// Relative (`90m`, `2h`, `3d`) or an ISO 8601 time → ISO UTC to the second.
export const parseDue = (s: string): string => {
  const rel = /^(\d{1,6})([mhd])$/.exec(s)
  const t = rel ? Date.now() + Number(rel[1]) * {m: 60e3, h: 3600e3, d: 86400e3}[rel[2] as 'm' | 'h' | 'd'] : Date.parse(s)
  if (!Number.isFinite(t)) fail(`--due takes 90m, 2h, 3d or an ISO time, not ${s}`)
  return new Date(t).toISOString().slice(0, 19) + 'Z'
}

// Extension trailers are part of a record's validity: a malformed decision record routes nowhere. Returns the reason.
export const check = (m: Parsed, isRef: (s: string) => boolean): string | null => {
  if (m.bad) return null
  for (const k of ['decider', 'reviewers', 'due', 'budget', 'supersedes', 'stamp', 'decision', 'control', 'grant', 'usage', 'run', 'seconds', 'exit']) {
    if ((m.trailers[k]?.length ?? 0) > 1) return `duplicate ${k}`
  }
  const ref = (k: string) => one(m, k) === null || isRef(one(m, k)!)
  if (!ref('grant')) return 'malformed Grant'
  if (!ref('control')) return 'malformed Control'
  if (one(m, 'budget') !== null && !parseBudget(one(m, 'budget'))) return 'malformed Budget'
  if (m.kind === 'proposal') {
    if (!ID_RE.test(one(m, 'decider') ?? '')) return 'proposal without a valid Decider'
    if (!ids(one(m, 'reviewers')).every(x => ID_RE.test(x))) return 'malformed Reviewers'
    if (one(m, 'due') !== null && !Number.isFinite(Date.parse(one(m, 'due')!))) return 'malformed Due'
    if (!ref('supersedes')) return 'malformed Supersedes'
  }
  if (m.kind === 'stamp' && (!m.re || !STAMPS.includes(one(m, 'stamp') ?? ''))) return 'stamp without Re or a valid Stamp'
  if (m.kind === 'decision' && (!m.re || !DECISIONS.includes(one(m, 'decision') ?? ''))) return 'decision without Re or a valid Decision'
  if (m.kind === 'usage') {
    if (!isRef(one(m, 'grant') ?? '') || !['reserve', 'settle'].includes(one(m, 'usage') ?? '') || !/^[A-Za-z0-9._:-]{1,128}$/.test(one(m, 'run') ?? '')) return 'malformed usage receipt'
    if (one(m, 'usage') === 'settle' && !/^\d{1,9}$/.test(one(m, 'seconds') ?? '')) return 'usage settle without Seconds'
  }
  return null
}

// The root always may; anyone else only within the authority table, and never on their own proposal.
export const mayDecide = (authority: Authority | null, decider: string, proposer: string, budget: Budget | null): boolean => {
  if (decider === ROOT) return true
  if (decider === proposer) return false
  const cap = authority?.decide?.[decider]
  if (!cap) return false
  if (!budget) return true
  return BUDGET_KEYS.every(k => Number.isFinite(cap[k]) && budget[k] <= cap[k]!)
}
// A decision names the room's control commit it was made under (`Control`); its authority is the table in effect
// there. A commit that does not exist yet cannot be named, so a later contract never promotes or demotes a decision.
const authorized = (m: Message, p: Message, decider: string, budget: Budget | null, authorityAt: AuthorityAt) => {
  if (m.from === ROOT) return true
  const table = authorityAt(one(m, 'control'))
  return m.from === decider && !!table && mayDecide(table, decider, p.from, budget)
}

export type Grant = {id: string, budget: Budget, proposal: Message, revoked: boolean}
export type Proposal = {
  proposal: Message
  decider: string
  reviewers: string[]
  budget: Budget | null
  due: number | null
  stamps: Record<string, {stamp: string, id: string, reason: string}>
  missing: string[]
  decision: {decision: string, id: string, by: string, time: number} | null
  revoked: {id: string, by: string, time: number} | null
  superseded: Message | null
  state: string
  grant: Grant | null
}
// Everything about one proposal, folded over the messages that answer it, in thread order.
export const proposalOf = (all: All, p: Message, authorityAt: AuthorityAt, now = Date.now() / 1000): Proposal => {
  const decider = one(p, 'decider')!
  const reviewers = ids(one(p, 'reviewers'))
  const budget = parseBudget(one(p, 'budget')) ?? null
  const due = one(p, 'due') ? Date.parse(one(p, 'due')!) / 1000 : null
  // A revision supersedes only when its author is the proposer or the root.
  const revisions = ordered([...all.values()].filter(m => !m.bad && m.kind === 'proposal' && one(m, 'supersedes') === p.id && (m.from === p.from || m.from === ROOT)))
  const answers = ordered([...all.values()].filter(m => !m.bad && m.reId === p.id && (m.kind === 'stamp' || m.kind === 'decision')))
  const stamps: Proposal['stamps'] = {}
  let decision: Proposal['decision'] = null
  let revoked: Proposal['revoked'] = null
  const superseded = revisions[0] ?? null
  const revocation = (m: Message) => !revoked && one(m, 'decision') === 'revoked' && (m.from === decider || m.from === ROOT)
  // A record after the superseding revision in thread order no longer applies to this revision.
  for (const m of ordered([...answers, ...(superseded ? [superseded] : [])])) {
    if (m === superseded) break
    // A reviewer's latest stamp counts; its position relative to the decision is only a same-second tie.
    if (m.kind === 'stamp' && reviewers.includes(m.from)) stamps[m.from] = {stamp: one(m, 'stamp')!, id: m.id, reason: m.subject}
    if (m.kind !== 'decision') continue
    const d = one(m, 'decision')!
    if (!decision && d !== 'revoked' && m.from === decider && authorized(m, p, decider, budget, authorityAt)) decision = {decision: d, id: m.id, by: m.from, time: m.time}
    else if (decision?.decision === 'approved' && revocation(m)) revoked = {id: m.id, by: m.from, time: m.time}
  }
  // After a superseding revision, only a revocation of an earlier approval still applies to this one.
  if (superseded && decision?.decision === 'approved') for (const m of answers) if (revocation(m)) revoked = {id: m.id, by: m.from, time: m.time}
  const missing = reviewers.filter(r => !stamps[r])
  const state = revoked ? 'revoked' : decision ? decision.decision : superseded ? 'superseded' : due && now > due ? 'overdue' : 'open'
  const grant = decision?.decision === 'approved' && budget ? {id: decision.id, budget, proposal: p, revoked: !!revoked} : null
  return {proposal: p, decider, reviewers, budget, due, stamps, missing, decision, revoked, superseded, state, grant}
}
export const proposals = (all: All, authorityAt: AuthorityAt): Proposal[] => [...all.values()].filter(m => !m.bad && m.kind === 'proposal').map(p => proposalOf(all, p, authorityAt))
export const grantOf = (all: All, authorityAt: AuthorityAt, id: string): Grant | null => {
  const d = all.get(id)
  if (!d || d.bad || d.kind !== 'decision' || !d.reId || !all.get(d.reId)) return null
  const g = proposalOf(all, all.get(d.reId)!, authorityAt).grant
  return g?.id === id ? g : null
}
export type Usage = {runs: number, open: number, uncertain: number, seconds: number, left: number}
// The receipts a grant's ledger counts, in thread order: every reservation, and for each run (its runner and Run id)
// the first settlement after its reservation, as the first decision counts. A settlement of no reserved run counts
// nothing.
const ledger = (all: All, grant: Grant) => {
  const reserves: Message[] = [], settled = new Map<string, Message>(), reserved = new Set<string>()
  for (const m of ordered([...all.values()].filter(m => !m.bad && m.kind === 'usage' && one(m, 'grant') === grant.id))) {
    const run = `${m.from}/${one(m, 'run')}`
    if (one(m, 'usage') === 'reserve') {
      reserves.push(m)
      reserved.add(run)
    } else if (reserved.has(run) && !settled.has(run)) settled.set(run, m)
  }
  return {reserves, settled}
}
// Whether a receipt counts: its Grant names a grant, and that grant's ledger holds it.
export const counted = (all: All, authorityAt: AuthorityAt, m: Message): boolean => {
  const g = !m.bad && m.kind === 'usage' ? grantOf(all, authorityAt, one(m, 'grant') ?? '') : null
  if (!g) return false
  const {reserves, settled} = ledger(all, g)
  return reserves.includes(m) || [...settled.values()].includes(m)
}
// Usage from the runners' receipts: every reservation is a run, settled or not; an unsettled one is open while its
// run could still be going, and uncertain after that.
export const usageOf = (all: All, grant: Grant, now = Date.now() / 1000): Usage => {
  const {reserves, settled} = ledger(all, grant)
  let seconds = 0
  for (const m of settled.values()) seconds += Number(one(m, 'seconds'))
  const unsettled = reserves.filter(m => !settled.has(`${m.from}/${one(m, 'run')}`))
  const open = unsettled.filter(m => now - m.time <= grant.budget['run-seconds'] + 60)
  return {runs: reserves.length, open: open.length, uncertain: unsettled.length - open.length, seconds, left: Math.max(0, grant.budget.runs - reserves.length)}
}
