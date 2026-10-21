// repos: a room's private repository in the organisation, and what GitHub enforces in it.

import {fail} from '../../lib/index.ts'
import type {Grants} from '../../core/hub/ports/access.ts'
import {typed} from './space.ts'
import type {Org, Repo, Space} from './space.ts'
import {deployKeys} from './keys.ts'

// Nobody but the root may write a room's repository through the organisation: its members get read at most, which only
// an owner may read, so a policy not shown is no proof; and the repository has no other collaborator. A deploy key is
// how an actor writes.
const orgClosed = async (S: Space) => {
  const org = await S.call<Org>('GET', `/orgs/${S.org}`) ?? fail(`no GitHub organisation ${S.org}`)
  const base = org.default_repository_permission
  if (base === 'write' || base === 'admin') fail(`every member of ${S.org} may write its repositories; set its base permission to read or none`)
  if (base !== 'read' && base !== 'none') fail(`GitHub shows this token no base permission of ${S.org}; it must be an owner's, so ringi can tell nobody else writes its rooms`)
}
const alone = async (S: Space, room: string, root: string) => {
  const others = (await S.pages<{login: string}>(`${S.repo(room)}/collaborators?affiliation=direct`)).map(c => c.login).filter(l => l !== root)
  if (others.length) fail(`${S.org}/${room} has other collaborators (${others.join(', ')}); ringi gives rooms on GitHub to the root alone`)
}
// Checked before a repository is made, and again after.
export const ensureRoom = async (S: Space, room: string) => {
  await orgClosed(S)
  const found = await S.call<Repo>('GET', S.repo(room))
  if (found && !found.private) fail(`${S.org}/${room} exists on GitHub and is public; ringi makes rooms in private repositories only`)
  if (!found) await S.call('POST', `/orgs/${S.org}/repos`, {name: room, private: true, auto_init: false})
  const repo = await S.call<Repo>('GET', S.repo(room))
  if (!repo?.private) return fail(`${S.org}/${room} on GitHub is not private`)
  await alone(S, room, await S.self())
  return {address: typed(repo.ssh_url)}
}
// What GitHub enforces in a room: whoever writes it writes every branch, the root and each write deploy key alike.
export const effective = async (S: Space, room: string): Promise<Grants> => {
  const writers = [await S.self(), ...(await deployKeys(S, room)).map(k => k.title)]
  return {main: writers, chat: writers, signals: {}}
}
