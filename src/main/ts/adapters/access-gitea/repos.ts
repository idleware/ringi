// Private repository creation and deletion, with the complete root/actor policy read back.
import {fail} from '../../lib/index.ts'
import {signalsOf} from './rule-shape.ts'
import type {Context, Repo} from './context.ts'
import type {RoomProvision} from '../../core/hub/ports/access.ts'
import {checkServerDelete, provisionRepository, sameRepository} from '../../core/hub/rooms/provider-repository.ts'

const typed = (ssh: string): string => {
  const scp = /^([^@/]+@[^:/]+):(.+)$/.exec(ssh)
  return scp ? `git+ssh://${scp[1]}/${scp[2]}` : `git+${ssh}`
}
const providerRepo = (r: Repo | null) => r && ({id: r.id, private: r.private, address: typeof r.ssh_url === 'string' ? typed(r.ssh_url) : null})
const readRepo = (c: Context, room: string) => async () => providerRepo(await c.api.call<Repo>('GET', c.repo(room)))
export const ensureRoom = async (c: Context, room: string, intent: RoomProvision) => {
  await c.version(); await c.root()
  const bound = await provisionRepository({read: readRepo(c, room), label: `${c.org}/${room}`,
    create: async () => providerRepo(await c.api.call<Repo>('POST', `/orgs/${c.org}/repos`, {name: room, private: true, auto_init: false, default_branch: 'main'})),
    hasChat: async () => !!await c.api.call('GET', `${c.repo(room)}/branches/chat`),
    privateError: `${c.org}/${room} exists on Gitea and is not private`}, intent)
  const root = await c.before(room), r = c.rules(room)
  await r.set('main', [root])
  if (!(await r.all()).some(x => x.rule_name === 'chat')) await r.set('chat', [root])
  await r.set(signalsOf('operator'), [root]); await r.set('**', [])
  await r.closeTags(root); await c.effective(room)
  const now = await c.api.call<Repo>('GET', c.repo(room))
  if (now) sameRepository(now, bound.repositoryId)
  if (now?.private !== true || typeof now.ssh_url !== 'string') return fail(`${c.org}/${room} on Gitea has no private repository address`)
  return {address: typed(now.ssh_url)}
}
export const deleteServer = async (c: Context, room: string, repositoryId: string) => {
  if (!await checkServerDelete(readRepo(c, room), repositoryId)) return
  await c.before(room, true)
  await c.api.call('DELETE', c.repo(room))
  if (await c.api.call('GET', c.repo(room))) fail(`${c.org}/${room} is still on Gitea after deleting it`)
}
