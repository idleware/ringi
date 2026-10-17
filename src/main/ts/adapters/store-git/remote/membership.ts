// Explicit git/4 membership wire. Tombstones are protocol state; no hosting identity or custody is stored here.
import {fail, strictJson} from '../../../lib/index.ts'
import {AGENT_RE} from '../../../core/hub/protocol/model.ts'
import type {Member} from '../../../core/hub/ports/store.ts'
import type {GitLayout, Signer} from './types.ts'

export type RetiredMember = {key: string | null, since: string}
export type Membership = {members: Record<string, Member>, retired: Record<string, RetiredMember>}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const actor = (who: string): boolean => AGENT_RE.test(who) && who !== 'main' && who !== 'chat'
const member = (v: unknown): v is Member => record(v) && Object.entries(v).every(([k, x]) => ['role', 'since'].includes(k) && typeof x === 'string')
const retiredMember = (v: unknown, signed: boolean): v is RetiredMember => {
  if (!record(v) || Object.keys(v).sort().join(',') !== 'key,since') return false
  const time = typeof v.since === 'string' && !!v.since && v.since.length <= 128 && !/[\x00-\x1f\x7f]/.test(v.since)
  const key = signed ? typeof v.key === 'string' && /^SHA256:[A-Za-z0-9+/]{43}$/.test(v.key) : v.key === null
  return time && key
}
const checkRetired = (state: Membership, signed: boolean): void => {
  const keys = new Set<string>()
  for (const [who, value] of Object.entries(state.retired)) {
    if (!actor(who) || who === 'operator' || Object.hasOwn(state.members, who) || !retiredMember(value, signed)) fail('invalid retired member or active/retired collision')
    if (value.key !== null) {
      if (keys.has(value.key)) fail('duplicate retired fingerprint')
      keys.add(value.key)
    }
  }
}
export const membershipFile = (text: string, layout: GitLayout, signed: boolean): Membership => {
  const value = strictJson<unknown>(text, 'members.json')
  if (layout === 'git/3') return {members: value as Record<string, Member>, retired: {}}
  if (layout !== 'git/4') return fail('unsupported membership wire layout')
  if (!record(value) || Object.keys(value).sort().join(',') !== 'members,retired' || !record(value.members) || !record(value.retired)) return fail('git/4 requires the explicit {members, retired} envelope')
  if (!Object.entries(value.members).every(([who, value]) => actor(who) && member(value))) return fail('invalid git/4 member map')
  const state = value as Membership
  if (state.members.operator?.role !== 'root' || Object.entries(state.members).some(([who, m]) => who !== 'operator' && m.role === 'root')) fail('membership must retain operator as its only root')
  checkRetired(state, signed)
  return state
}
export const membershipText = (state: Membership, layout: GitLayout): string => JSON.stringify(layout === 'git/4' ? state : state.members, null, 2) + '\n'
export const checkRetiredKeys = (state: Membership, entries: Signer[]): void => {
  const retired = new Set(Object.values(state.retired).map(r => r.key))
  if (entries.some(e => retired.has(e.key.fp))) fail('a retired fingerprint cannot be admitted again')
}
