// rules: one room repository's branch and tag protections, as ringi's matrix wants them and as the forge reads back.

import {fail} from '../../lib/index.ts'
import type {Grants} from '../../core/hub/ports/access.ts'
import {AGENT_RE} from '../../core/hub/protocol/index.ts'
import type {Call} from './api.ts'

type Rule = {rule_name: string, enable_push?: boolean, enable_push_whitelist?: boolean, push_whitelist_usernames: string[] | null,
  push_whitelist_teams?: string[] | null, push_whitelist_deploy_keys?: boolean, unprotected_file_patterns?: string}
type TagRule = {name_pattern: string, whitelist_usernames?: string[] | null, whitelist_teams?: string[] | null}
// An actor's one branch of its own: its signals.
export const signalsOf = (actor: string) => `${actor}/signals`

// Who a rule lets push: those it names, only while it lets pushes through its list at all.
const pushers = (rs: Rule[], name: string) => {
  const r = rs.find(x => x.rule_name === name)
  return r?.enable_push && r.enable_push_whitelist ? r.push_whitelist_usernames ?? [] : []
}
const actorOf = (n: string) => n.endsWith('/signals') ? n.slice(0, -'/signals'.length) : null
const known = (n: string) => ['main', 'chat', '**'].includes(n) || AGENT_RE.test(actorOf(n) ?? '')
const loose = (r: Rule) => (r.push_whitelist_teams ?? []).length || r.push_whitelist_deploy_keys || r.unprotected_file_patterns || (r.enable_push && !r.enable_push_whitelist)
// Whom a rule lists, whatever it lets; and whom it names as its only pushers, none for one that lets more than it lists.
const listed = (rs: Rule[], name: string) => rs.find(x => x.rule_name === name)?.push_whitelist_usernames ?? []
const named = (rs: Rule[], name: string) => {
  const r = rs.find(x => x.rule_name === name)
  return r && loose(r) ? null : listed(rs, name)
}
const shut = (r: Rule | undefined) => !!r && !r.enable_push && !(r.push_whitelist_usernames ?? []).length
// Tags are closed by one rule for all of them that only the root may pass, or nobody. ringi makes the first: Forgejo
// takes no tag rule that names nobody, though one closed by hand may be kept so.
const closed = (tags: TagRule[], root: string[]) => {
  const all = tags.length === 1 && tags[0].name_pattern === '*' && !(tags[0].whitelist_teams ?? []).length
  return all && root.length === 1 && ['', root[0]].includes((tags[0].whitelist_usernames ?? []).join())
}
const actors = (rs: Rule[]) => [...new Set(rs.flatMap(r => actorOf(r.rule_name) ?? []))]
// An actor's signals are its own when exactly one account may push them.
const owner = (rs: Rule[], actor: string) => {
  const p = pushers(rs, signalsOf(actor))
  return p.length === 1 ? p[0] : null
}
// Accounts that push the signals of more than one actor: neither could be told from the other.
const shared = (rs: Rule[]) => {
  const by: Record<string, string[]> = {}
  for (const a of actors(rs)) { const p = owner(rs, a); if (p) (by[p] ??= []).push(a) }
  return Object.entries(by).filter(([, as]) => as.length > 1).map(([p, as]) => `${p} pushes the signals of ${as.join(' and ')}`)
}
// What lets more than the matrix, or is missing from it: an unknown rule, one that lets every writer, teams, deploy
// keys or files through, main, chat or the "nobody" fallback missing, an actor whose signals more than one account pushes, one account for
// several actors, or a tag rule that lets anyone but the root.
const wider = (rs: Rule[], tags: TagRule[]): string[] => [
  ...rs.filter(r => !known(r.rule_name)).map(r => `rule ${r.rule_name}`),
  ...rs.filter(loose).map(r => `rule ${r.rule_name} lets every writer, teams, deploy keys or files through`),
  ...['main', 'chat'].filter(n => !rs.some(r => r.rule_name === n)).map(n => `no ${n} rule`),
  ...(shut(rs.find(r => r.rule_name === '**')) ? [] : ['no "**" rule that lets nobody push']),
  ...actors(rs).filter(a => !owner(rs, a)).map(a => `${a}'s signals do not let exactly one account push`),
  ...shared(rs),
  ...(closed(tags, pushers(rs, 'main')) ? [] : ['tags are not closed to all but the root']),
]
const signals = (rs: Rule[]): Grants['signals'] => Object.fromEntries(actors(rs).map(a => [a, owner(rs, a)!]))

export const rulesOf = (call: Call, repo: string) => {
  const all = async () => (await call<Rule[]>('GET', `${repo}/branch_protections`)) ?? []
  const tags = async () => (await call<TagRule[]>('GET', `${repo}/tag_protections`)) ?? []
  const path = (name: string) => `${repo}/branch_protections/${encodeURIComponent(name)}`
  return {
    pushers: async (name: string) => pushers(await all(), name),
    named: async (name: string) => named(await all(), name),
    // The actors whose signals rule lists this account, whatever else the rule lets.
    holders: async (principal: string) => { const rs = await all(); return actors(rs).filter(a => listed(rs, signalsOf(a)).includes(principal)) },
    has: async (name: string) => (await all()).some(r => r.rule_name === name),
    // Exactly these pushers, made or changed; none lets nobody push.
    set: async (name: string, users: string[]) => {
      const body = {enable_push: users.length > 0, enable_push_whitelist: true, push_whitelist_usernames: users, push_whitelist_deploy_keys: false,
        apply_to_admins: true, unprotected_file_patterns: ''}
      if ((await all()).some(r => r.rule_name === name)) await call('PATCH', path(name), body)
      else await call('POST', `${repo}/branch_protections`, {rule_name: name, ...body})
    },
    drop: async (name: string) => { if ((await all()).some(r => r.rule_name === name)) await call('DELETE', path(name)) },
    closeTags: async (root: string) => { if (!(await tags()).some(t => t.name_pattern === '*')) await call('POST', `${repo}/tag_protections`, {name_pattern: '*', whitelist_usernames: [root]}) },
    // The grants the rules enforce, once nothing in them lets more.
    effective: async (room: string): Promise<Grants> => {
      const rs = await all(), why = wider(rs, await tags())
      if (why.length) fail(`room ${room} on Forgejo allows more than ringi's rules: ${why.join('; ')}`)
      return {main: pushers(rs, 'main'), chat: pushers(rs, 'chat'), signals: signals(rs)}
    },
  }
}
