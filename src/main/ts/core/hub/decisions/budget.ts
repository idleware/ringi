// budget: what a decision grants (a budget), until when a proposal waits (its due time), and who may decide it.

import {fail} from '../../../lib/index.ts'

export const ROOT = 'operator'
export const BUDGET_KEYS = ['runs', 'run-seconds', 'concurrency'] as const
export type Budget = {runs: number, 'run-seconds': number, concurrency: number}
// Who may decide up to which budget: {"decide": {"<id>": {"runs": n, "run-seconds": n, "concurrency": n}}}.
export type Authority = {decide?: Record<string, Partial<Budget>>}
export type AuthorityAt = (control: string | null) => Authority | null

export const ids = (v: string | null): string[] => v === null ? [] : [...new Set(v.split(',').map(x => x.trim()).filter(Boolean))]

const PART = /^([a-z][a-z-]*)=(\d{1,9})$/
// `runs=5, run-seconds=600, concurrency=1`; undefined if malformed. `runs` is required: a budget without a run count
// bounds nothing; a zero run time or concurrency would disable the bound it names.
export const parseBudget = (s: string | null | undefined): Budget | null | undefined => {
  if (s === null || s === undefined) return null
  const b: Partial<Budget> = {}
  for (const part of String(s).split(',').map(x => x.trim()).filter(Boolean)) {
    const m = PART.exec(part)
    if (!m || !(BUDGET_KEYS as readonly string[]).includes(m[1]) || m[1] in b) return undefined
    b[m[1] as keyof Budget] = Number(m[2])
  }
  return bounded(b) ? {'run-seconds': 1800, concurrency: 1, ...b} as Budget : undefined
}
const bounded = (b: Partial<Budget>): boolean => 'runs' in b && b['run-seconds'] !== 0 && b.concurrency !== 0
export const budgetText = (b: Budget): string => BUDGET_KEYS.map(k => `${k}=${b[k]}`).join(', ')
const UNIT = {m: 60e3, h: 3600e3, d: 86400e3}
// Relative (`90m`, `2h`, `3d`) or an ISO 8601 time → ISO UTC to the second.
export const parseDue = (s: string): string => {
  const rel = /^(\d{1,6})([mhd])$/.exec(s)
  const t = rel ? Date.now() + Number(rel[1]) * UNIT[rel[2] as keyof typeof UNIT] : Date.parse(s)
  if (!Number.isFinite(t)) fail(`--due takes 90m, 2h, 3d or an ISO time, not ${s}`)
  return new Date(t).toISOString().slice(0, 19) + 'Z'
}
const within = (cap: Partial<Budget>, budget: Budget): boolean => BUDGET_KEYS.every(k => Number.isFinite(cap[k]) && budget[k] <= cap[k]!)
// The root always may; anyone else only within the authority table, and never on their own proposal.
export const mayDecide = (authority: Authority | null, decider: string, proposer: string, budget: Budget | null): boolean => {
  if (decider === ROOT) return true
  const cap = decider === proposer ? undefined : authority?.decide?.[decider]
  return !!cap && (!budget || within(cap, budget))
}
