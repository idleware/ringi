// Private repository creation and deletion, with the complete root/actor policy read back.
import {fail} from '../../lib/index.ts'
import {signalsOf} from './rule-shape.ts'
import type {Context, Repo} from './context.ts'

const typed = (ssh: string): string => {
  const scp = /^([^@/]+@[^:/]+):(.+)$/.exec(ssh)
  return scp ? `git+ssh://${scp[1]}/${scp[2]}` : `git+${ssh}`
}
export const ensureRoom = async (c: Context, room: string) => {
  await c.version(); await c.root()
  const found = await c.api.call<Repo>('GET', c.repo(room))
  if (found && found.private !== true) fail(`${c.org}/${room} exists on Gitea and is not private`)
  if (!found) await c.api.call('POST', `/orgs/${c.org}/repos`, {name: room, private: true, auto_init: false, default_branch: 'main'})
  const root = await c.before(room), r = c.rules(room)
  await r.set('main', [root])
  if (!(await r.all()).some(x => x.rule_name === 'chat')) await r.set('chat', [root])
  await r.set(signalsOf('operator'), [root]); await r.set('**', [])
  await r.closeTags(root); await c.effective(room)
  const now = await c.api.call<Repo>('GET', c.repo(room))
  if (now?.private !== true || typeof now.ssh_url !== 'string') return fail(`${c.org}/${room} on Gitea has no private repository address`)
  return {address: typed(now.ssh_url)}
}
export const deleteServer = async (c: Context, room: string) => {
  if (await c.api.call('GET', c.repo(room)) === null) return
  await c.before(room, true)
  await c.api.call('DELETE', c.repo(room))
  if (await c.api.call('GET', c.repo(room))) fail(`${c.org}/${room} is still on Gitea after deleting it`)
}
