// parse: a profile is refused, not guessed at, when it is not exactly what its schema describes.

import {ID_RE, TOKEN_RE} from '../protocol/index.ts'
import {fail, strictJson} from '../../../lib/index.ts'
import {PROFILE_SCHEMA} from './index.ts'
import type {Profile} from './index.ts'

const PRINCIPAL_RE = /^(?:requester|assignee|member|role:[a-z][a-z0-9-]*|agent:[a-z0-9]+(?:[._-][a-z0-9]+)*)$/
const RULE_RE = /^(?:assign|roles|grant|state:(?:\*|[a-z][a-z0-9-]*))$/
const distinctTokens = (xs: unknown): boolean =>
  Array.isArray(xs) && xs.length > 0 && xs.every(s => TOKEN_RE.test(s)) && new Set(xs).size === xs.length
const principals = (v: unknown): boolean => Array.isArray(v) && v.length <= 64 && v.every(x => PRINCIPAL_RE.test(x))
const waitingOk = (p: Profile): boolean => p.waiting === undefined || (p.states.includes(p.waiting) && !p.terminal.includes(p.waiting))
// The profile's shape, checked in order: each check may rely on the ones before it.
const SHAPE: Array<[(p: Profile) => boolean, (p: Profile) => string]> = [
  [p => p.schema === PROFILE_SCHEMA, p => `schema ${String(p.schema)} is not ${PROFILE_SCHEMA}; upgrade ringi or fix the profile`],
  [p => ID_RE.test(p.name ?? ''), () => 'a profile needs a name like team-flow-1'],
  [p => TOKEN_RE.test(p.opens ?? ''), () => '`opens` names the Kind that opens a piece of work'],
  [p => distinctTokens(p.states), () => '`states` must be distinct tokens'],
  [p => p.states.includes(p.initial), () => '`initial` must be one of the states'],
  [p => Array.isArray(p.terminal) && p.terminal.every(s => p.states.includes(s)), () => '`terminal` must list states'],
  [waitingOk, () => '`waiting` must be a state that does not end the work'],
  [p => !!p.rules && typeof p.rules === 'object', () => '`rules` is required'],
]
// Why one rule is wrong, or null.
const ruleProblem = (p: Profile, k: string, v: unknown): string | null => {
  if (!RULE_RE.test(k)) return `unknown rule ${k}`
  if (k.startsWith('state:') && k !== 'state:*' && !p.states.includes(k.slice(6))) return `rule ${k} names an unknown state`
  return principals(v) ? null : `rule ${k} must list principals: requester, assignee, member, role:<label>, agent:<id>`
}
export const parseProfile = (text: string, label: string): Profile => {
  const p = strictJson<Profile>(text, label)
  const wrong = SHAPE.find(([ok]) => !ok(p))
  const why = wrong ? wrong[1](p) : Object.entries(p.rules).map(([k, v]) => ruleProblem(p, k, v)).find(x => x)
  if (why) fail(`${label}: ${why}`)
  return p
}
