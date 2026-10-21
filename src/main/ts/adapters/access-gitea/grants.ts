// Account-only grants and resumable revocation; no third-party key enrolment or deploy keys.
import {fail} from '../../lib/index.ts'
import {account} from './accounts.ts'
import {pushers, signalsOf} from './rule-shape.ts'
import {grantMapping, revokeMapping, same} from './policy.ts'
import type {Context} from './context.ts'
type Request = {room: string, actor: string, principal: string, key?: string}

export const grant = async (c: Context, q: Request) => {
  const {room, actor} = q
  await c.notRoot(actor, q.principal)
  if (q.key) fail('Gitea account keys must be enrolled by their owner and verified before admission')
  const principal = (await account(c.api, q.principal))?.login ?? fail(`Gitea has no account ${q.principal}`)
  const root = await c.before(room, true), r = c.rules(room), now = await r.check(root, true)
  grantMapping(now, actor, principal)
  await c.api.call('PUT', `${c.repo(room)}/collaborators/${encodeURIComponent(principal)}`, {permission: 'write'})
  await r.set('chat', [...new Set([...now.chat, principal])]); await r.set(signalsOf(actor), [principal])
  const after = await c.effective(room), permission = await c.permission(room, principal)
  if (!['write', 'admin', 'owner'].includes(permission)) fail(`${principal} has no Gitea repository write permission after the grant`)
  if (after.signals[actor] !== principal || !after.chat.includes(principal)) fail(`${principal} cannot write ${actor}'s signals and chat after the Gitea grant`)
}
export const revoke = async (c: Context, {room, actor, principal}: Request) => {
  await c.notRoot(actor, principal)
  const root = await c.before(room, true), r = c.rules(room), rows = await r.all()
  revokeMapping(rows, actor, principal)
  await r.drop(signalsOf(actor))
  await r.set('chat', pushers(rows.find(x => x.rule_name === 'chat')).filter(p => !same(p, principal)))
  await c.api.call('DELETE', `${c.repo(room)}/collaborators/${encodeURIComponent(principal)}`)
  const after = await r.check(root, true), permission = await c.permission(room, principal)
  const retained = [Object.hasOwn(after.signals, actor), after.chat.some(p => same(p, principal)), !['none', 'read'].includes(permission)]
  if (retained.some(Boolean)) fail(`${principal} still writes ${c.org}/${room} after the Gitea revocation`)
}
