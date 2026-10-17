// Historical membership is read only at the selected room's accepted controls, under its explicit wire layout.
import {fail, strictJson} from '../../../lib/index.ts'
import {AGENT_RE} from '../protocol/model.ts'
import type {Member, Rev, Store, StoredRoom} from '../ports/store.ts'

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const member = (value: unknown): value is Member => {
  if (!record(value)) return false
  return Object.entries(value).every(([key, field]) => ['role', 'since'].includes(key) && typeof field === 'string')
}
const map = (value: unknown): Record<string, Member> => {
  if (!record(value) || !Object.entries(value).every(([actor, value]) => AGENT_RE.test(actor) && member(value))) {
    return fail('members.json must contain an actor-to-member map')
  }
  const entries = Object.entries(value).map(([actor, value]) => [actor, Object.freeze({...value as Member})])
  return Object.freeze(Object.fromEntries(entries))
}
const members = (value: unknown, layout: string): Record<string, Member> => {
  if (layout === 'git/3') return map(value)
  if (layout !== 'git/4') return fail('unsupported membership layout ' + layout)
  if (!record(value) || !record(value.retired) || !Object.hasOwn(value, 'members')) return fail('git/4 members.json requires {members, retired}')
  const active = map(value.members)
  if (Object.keys(value.retired).some(actor => Object.hasOwn(active, actor))) return fail('a retired actor is still a member')
  return active
}
export const membershipAt = (store: Pick<Store, 'controlFile'>, room: StoredRoom, layout: string): (control: Rev) => Record<string, Member> => {
  const controls = new Set(room.control.map(c => c.rev)), cache = new Map<Rev, Record<string, Member>>()
  return control => {
    if (!controls.has(control)) return fail('membership Control is not an accepted control of this room')
    const old = cache.get(control)
    if (old) return old
    const text = store.controlFile(room, 'members.json', control) ?? fail('accepted control has no members.json')
    const found = members(strictJson<unknown>(text, 'members.json'), layout)
    cache.set(control, found)
    return found
  }
}
