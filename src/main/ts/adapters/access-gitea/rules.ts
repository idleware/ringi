// Gitea chooses the first matching rule by numeric priority; every literal precedes the deny fallback.
import {fail} from '../../lib/index.ts'
import type {Api} from './api.ts'
import {branchBody, isRule, isTag, loose, pushers} from './rule-shape.ts'
import {ordered, policy} from './policy.ts'
import type {Rule, Tag} from './rule-shape.ts'
export {listed, pushers, signalsOf} from './rule-shape.ts'
export type {Rule} from './rule-shape.ts'

export class Rules {
  private readonly api: Api
  private readonly repo: string
  constructor(api: Api, repo: string) { this.api = api; this.repo = repo }
  async all(): Promise<Rule[]> {
    const rows = await this.api.call<unknown>('GET', `${this.repo}/branch_protections`)
    if (!Array.isArray(rows) || !rows.every(isRule)) return fail('Gitea unknown or malformed branch policy (numeric priority and force-push flags required)')
    if (new Set(rows.map(r => r.rule_name)).size !== rows.length) fail('Gitea duplicated branch policy')
    if (rows.some(loose)) fail('Gitea branch policy permits force pushes, teams, deploy keys or unprotected files')
    ordered(rows)
    return rows
  }
  async tags(): Promise<Tag[]> {
    const rows = await this.api.call<unknown>('GET', `${this.repo}/tag_protections`)
    if (!Array.isArray(rows) || !rows.every(isTag)) return fail('Gitea not a complete tag policy')
    return rows
  }
  async check(root: string, complete: boolean) { return policy(await this.all(), await this.tags(), root, complete) }
  async set(name: string, users: string[]) {
    const rows = await this.all(), last = Math.max(0, ...rows.filter(r => r.rule_name !== '**').map(r => r.priority))
    const body = branchBody(name, users, name === '**' ? last + 1 : 1), had = rows.some(r => r.rule_name === name)
    await this.api.call(had ? 'PATCH' : 'POST', `${this.repo}/branch_protections${had ? '/' + encodeURIComponent(name) : ''}`, body)
    const now = (await this.all()).find(r => r.rule_name === name)
    if (!now || now.priority !== body.priority || pushers(now).join('\0') !== users.join('\0')) fail(`Gitea ${name} policy did not take effect`)
  }
  async closeTags(root: string) {
    if (!(await this.tags()).length) await this.api.call('POST', `${this.repo}/tag_protections`, {name_pattern: '*', whitelist_usernames: [root], whitelist_teams: []})
  }
  async drop(name: string) {
    const path = `${this.repo}/branch_protections/${encodeURIComponent(name)}`
    if ((await this.all()).some(r => r.rule_name === name)) await this.api.call('DELETE', path)
    if ((await this.all()).some(r => r.rule_name === name)) fail(`Gitea ${name} policy remains after deletion`)
  }
}
export const rulesOf = (api: Api, repo: string) => new Rules(api, repo)
