// keys: the keys GitHub keeps for a space: the root's on its own account, an account's for proof, a room's deploy
// keys, and GitHub's own SSH host keys. Lists are read whole or not at all: a key a list leaves out is no proof.

import {fail} from '../../lib/index.ts'
import type {Account, DeployKey} from '../../core/hub/ports/access.ts'
import {keyLine, titleOf} from './space.ts'
import type {Key, Space} from './space.ts'

// The root's own key on its account, added once and read back.
export const ownKey = async (S: Space, key: string) => {
  const line = keyLine(key), has = async () => (await S.pages<{key: string}>('/user/keys')).some(k => keyLine(k.key) === line)
  if (await has()) return
  const r = await S.call<unknown>('POST', '/user/keys', {title: titleOf(line), key: line}).catch((e: Error) => e)
  if (r instanceof Error) fail(`${r.message}; add this key to ${await S.self()}'s SSH keys on GitHub by hand, then create the room again: ${line}`)
  if (!await has()) fail(`the key is not on ${await S.self()}'s account after adding it: ${line}`)
}
export const account = async (S: Space, login: string): Promise<Account | null> => {
  const u = await S.call<{id?: unknown, login?: unknown, type?: unknown}>('GET', `/users/${encodeURIComponent(login)}`)
  if (u === null) return null
  if (typeof u.id !== 'number' || typeof u.login !== 'string' || u.login.toLowerCase() !== login.toLowerCase()) return fail(`GitHub answered for ${login} with no account of that name`)
  return u.type === 'User' ? {id: String(u.id), login: u.login} : fail(`${login} on GitHub is no user account`)
}
export const accountKeys = async (S: Space, a: Account): Promise<string[]> => {
  const now = await account(S, a.login)
  if (!now || (a.id !== null && now.id !== a.id)) fail(`${a.login} on GitHub is not the account it was (${a.id ?? 'no id'})`)
  const keys = await S.pages<{key?: unknown}>(`/users/${encodeURIComponent(a.login)}/keys`)
  if (!keys.every(k => typeof k.key === 'string')) fail(`GitHub answered ${a.login}'s keys with something that is not a list of keys`)
  return [...new Set(keys.map(k => keyLine(String(k.key))))]
}
export const deployKeys = async (S: Space, room: string): Promise<DeployKey[]> =>
  (await S.pages<Key>(`${S.repo(room)}/keys`)).filter(k => !k.read_only).map(k => ({record: String(k.id), key: keyLine(k.key), title: k.title}))
// One write key per actor, under its label; the same key and label again changes nothing, another label refuses.
export const deployKey = async (S: Space, room: string, label: string, key: string): Promise<DeployKey> => {
  const line = keyLine(key), had = (await deployKeys(S, room)).find(k => k.key === line)
  if (had) return had.title === label ? had : fail(`this key writes ${S.org}/${room} as ${had.title} already, not as ${label}`)
  const made = await S.call<Key>('POST', `${S.repo(room)}/keys`, {title: label, key: line, read_only: false})
  return made ? {record: String(made.id), key: keyLine(made.key), title: made.title} : fail(`GitHub made no deploy key for ${label}`)
}
export const dropDeployKey = async (S: Space, room: string, record: string) => {
  if (!/^\d+$/.test(record)) fail(`no deploy key record ${record}`)
  await S.call('DELETE', `${S.repo(room)}/keys/${record}`)
  if (await S.call('GET', `${S.repo(room)}/keys/${record}`)) fail(`the deploy key ${record} is still on ${S.org}/${room} after deleting it`)
}
// GitHub's SSH host keys, from its API over TLS, as known_hosts lines for the host the space is on.
export const hostKeys = async (S: Space): Promise<string[]> => {
  const meta = await S.call<{ssh_keys?: unknown}>('GET', '/meta')
  const keys = Array.isArray(meta?.ssh_keys) ? meta.ssh_keys.filter((k): k is string => typeof k === 'string') : []
  return keys.length ? keys.map(k => `${S.host} ${keyLine(k)}`) : fail('GitHub serves no SSH host keys')
}

