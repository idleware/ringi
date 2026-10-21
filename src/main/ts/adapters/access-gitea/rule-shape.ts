// A supported Gitea rule has explicit priority, force-push and whitelist fields, even when disabled.
import {AGENT_RE} from '../../core/hub/protocol/index.ts'
export type Rule = {rule_name: string, priority: number, enable_push: boolean, enable_push_whitelist: boolean,
  push_whitelist_usernames: string[] | null, push_whitelist_teams: string[] | null, push_whitelist_deploy_keys: boolean,
  enable_force_push: boolean, unprotected_file_patterns: string}
export type Tag = {name_pattern: string, whitelist_usernames: string[] | null, whitelist_teams: string[] | null}
export const signalsOf = (actor: string) => `${actor}/signals`
export const actorOf = (name: string) => name.endsWith('/signals') ? name.slice(0, -8) : null
const known = (name: string) => {
  if (['main', 'chat', '**'].includes(name)) return true
  const actor = actorOf(name) ?? ''
  return AGENT_RE.test(actor) && !['main', 'chat'].includes(actor)
}
const strings = (x: unknown): x is string[] | null => x === null || Array.isArray(x) && x.every(v => typeof v === 'string')
export const isRule = (x: unknown): x is Rule => {
  if (!x || typeof x !== 'object') return false
  const r = x as Rule
  if (typeof r.rule_name !== 'string' || !known(r.rule_name)) return false
  if (!Number.isSafeInteger(r.priority) || r.priority <= 0) return false
  const flags = [r.enable_push, r.enable_push_whitelist, r.push_whitelist_deploy_keys, r.enable_force_push]
  if (!flags.every(v => typeof v === 'boolean')) return false
  return strings(r.push_whitelist_usernames) && strings(r.push_whitelist_teams) && typeof r.unprotected_file_patterns === 'string'
}
export const isTag = (x: unknown): x is Tag => {
  if (!x || typeof x !== 'object') return false
  const t = x as Tag
  return typeof t.name_pattern === 'string' && strings(t.whitelist_usernames) && strings(t.whitelist_teams)
}
export const listed = (r?: Rule): string[] => r?.push_whitelist_usernames ?? []
export const pushers = (r?: Rule): string[] => r?.enable_push && r.enable_push_whitelist ? listed(r) : []
export const loose = (r: Rule) => {
  const extra = [r.enable_force_push, r.push_whitelist_deploy_keys, !!r.push_whitelist_teams?.length, !!r.unprotected_file_patterns]
  return extra.some(Boolean) || r.enable_push && !r.enable_push_whitelist
}
export const branchBody = (name: string, users: string[], priority: number) => ({rule_name: name, priority,
  enable_push: users.length > 0, enable_push_whitelist: true, push_whitelist_usernames: users,
  push_whitelist_teams: [], push_whitelist_deploy_keys: false, enable_force_push: false,
  enable_force_push_allowlist: false, force_push_allowlist_usernames: [], force_push_allowlist_teams: [],
  force_push_allowlist_deploy_keys: false, unprotected_file_patterns: ''})
