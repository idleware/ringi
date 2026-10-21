// One credentialed Gitea space and the read-only preflights shared by its operations.
import {fail} from '../../lib/index.ts'
import {AGENT_RE} from '../../core/hub/protocol/index.ts'
import {caller, space} from './api.ts'
import {rulesOf} from './rules.ts'
import {same} from './policy.ts'
import type {Api} from './api.ts'
export type Repo = {private?: unknown, ssh_url?: unknown}

export class Context {
  readonly api: Api
  readonly org: string
  constructor(locator: string, authRef: string) {
    const s = space(locator)
    this.org = s.org; this.api = caller(s.api, authRef)
  }
  repo(room: string) { return `/repos/${this.org}/${encodeURIComponent(room)}` }
  rules(room: string) { return rulesOf(this.api, this.repo(room)) }
  async root(): Promise<string> {
    const u = await this.api.call<{login?: unknown}>('GET', '/user')
    return typeof u?.login === 'string' && u.login.length ? u.login : fail('Gitea names no user for this token')
  }
  async version(): Promise<string> {
    const v = await this.api.call<{version?: unknown}>('GET', '/version')
    if (typeof v?.version !== 'string' || !/^1\.(25|26|27)\.\d+(?:[+-][a-zA-Z0-9.-]+)?$/.test(v.version))
      return fail('Gitea account spaces require the supported 1.25–1.27 priority/force-push API')
    return v.version
  }
  async before(room: string, complete = false) {
    await this.version()
    if ((await this.api.call<Repo>('GET', this.repo(room)))?.private !== true) fail(`${this.org}/${room} on Gitea is not private`)
    const root = await this.root()
    await this.rules(room).check(root, complete)
    return root
  }
  async notRoot(actor: string, principal: string) {
    if (!AGENT_RE.test(actor) || ['main', 'chat'].includes(actor)) fail(`invalid Gitea actor ${actor}`)
    if (!principal || principal.trim() !== principal) fail('Gitea needs an account login')
    if (actor === 'operator' || same(principal, await this.root())) fail('the operator and the root account are neither granted nor revoked')
  }
  async permission(room: string, principal: string) {
    const p = await this.api.call<{permission?: unknown}>('GET', `${this.repo(room)}/collaborators/${encodeURIComponent(principal)}/permission`)
    if (p === null) return 'none'
    return typeof p.permission === 'string' ? p.permission : fail('Gitea returned no collaborator permission')
  }
  async effective(room: string) { await this.version(); return this.rules(room).check(await this.root(), true) }
}
