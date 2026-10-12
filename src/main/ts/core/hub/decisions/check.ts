// check: the extension's trailers are part of a record's validity; a malformed decision record routes nowhere.

import {ID_RE, one} from '../protocol/index.ts'
import type {Parsed} from '../protocol/index.ts'
import {ids, parseBudget} from './budget.ts'

export const STAMPS = ['approve', 'object', 'abstain']
export const DECISIONS = ['approved', 'rejected', 'revoked']
const SINGLE = ['decider', 'reviewers', 'due', 'budget', 'supersedes', 'stamp', 'decision', 'control', 'grant', 'usage', 'run', 'seconds', 'exit']
const RUN = /^[A-Za-z0-9._:-]{1,128}$/

type Ref = (s: string) => boolean
type Rule = [() => boolean, string]
// A trailer absent, or a message id.
const refOk = (m: Parsed, k: string, isRef: Ref): boolean => one(m, k) === null || isRef(one(m, k)!)
const answers = (m: Parsed, values: string[], k: string): boolean => !!m.re && values.includes(one(m, k) ?? '')
const receipt = (m: Parsed, isRef: Ref): boolean =>
  isRef(one(m, 'grant') ?? '') && ['reserve', 'settle'].includes(one(m, 'usage') ?? '') && RUN.test(one(m, 'run') ?? '')
const dueOk = (v: string | null): boolean => v === null || Number.isFinite(Date.parse(v))
// What each kind of record must carry, as (wrong, why) in the order the reasons are reported.
const BY_KIND: Record<string, (m: Parsed, isRef: Ref) => Rule[]> = {
  proposal: (m, isRef) => [
    [() => !ID_RE.test(one(m, 'decider') ?? ''), 'proposal without a valid Decider'],
    [() => !ids(one(m, 'reviewers')).every(x => ID_RE.test(x)), 'malformed Reviewers'],
    [() => !dueOk(one(m, 'due')), 'malformed Due'],
    [() => !refOk(m, 'supersedes', isRef), 'malformed Supersedes'],
  ],
  stamp: m => [[() => !answers(m, STAMPS, 'stamp'), 'stamp without Re or a valid Stamp']],
  decision: m => [[() => !answers(m, DECISIONS, 'decision'), 'decision without Re or a valid Decision']],
  usage: (m, isRef) => [
    [() => !receipt(m, isRef), 'malformed usage receipt'],
    [() => one(m, 'usage') === 'settle' && !/^\d{1,9}$/.test(one(m, 'seconds') ?? ''), 'usage settle without Seconds'],
  ],
}
// Why a record is malformed for this extension, or null.
export const check = (m: Parsed, isRef: Ref): string | null => {
  if (m.bad) return null
  const twice = SINGLE.find(k => (m.trailers[k]?.length ?? 0) > 1)
  if (twice) return `duplicate ${twice}`
  const rules: Rule[] = [
    [() => !refOk(m, 'grant', isRef), 'malformed Grant'],
    [() => !refOk(m, 'control', isRef), 'malformed Control'],
    [() => one(m, 'budget') !== null && !parseBudget(one(m, 'budget')), 'malformed Budget'],
    ...BY_KIND[m.kind ?? '']?.(m, isRef) ?? [],
  ]
  return rules.find(([wrong]) => wrong())?.[1] ?? null
}
