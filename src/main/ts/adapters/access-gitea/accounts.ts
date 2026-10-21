// Account identity and complete public key lists, without enrolling another account's key.
import crypto from 'node:crypto'
import {fail} from '../../lib/index.ts'
import type {Account} from '../../core/hub/ports/access.ts'
import type {Api} from './api.ts'

export const keyLine = (key: string) => key.trim().split(/\s+/).slice(0, 2).join(' ')
export const account = async (api: Api, login: string): Promise<Account | null> => {
  const u = await api.call<{id?: unknown, login?: unknown}>('GET', `/users/${encodeURIComponent(login)}`)
  if (u === null) return null
  if (!Number.isSafeInteger(u.id) || Number(u.id) <= 0 || typeof u.login !== 'string' || u.login.toLowerCase() !== login.toLowerCase())
    return fail(`Gitea answered for ${login} with no account of that name`)
  return {id: String(u.id), login: u.login}
}
const keyList = async (api: Api, path: string): Promise<string[]> => {
  const isKey = (k: unknown): k is {key: string} => !!k && typeof k === 'object' && typeof (k as {key?: unknown}).key === 'string'
  const keys = await api.pages(path, isKey)
  return [...new Set(keys.map(k => keyLine(k.key)))]
}
export const accountKeys = async (api: Api, a: Account): Promise<string[]> => {
  const now = await account(api, a.login)
  if (!now || a.id === null || now.id !== a.id) fail(`${a.login} on Gitea is not the account it was (${a.id ?? 'no id'})`)
  return keyList(api, `/users/${encodeURIComponent(a.login)}/keys`)
}
export const ownKey = async (api: Api, key: string) => {
  const line = keyLine(key), has = async () => (await keyList(api, '/user/keys')).includes(line)
  if (await has()) return
  const title = `ringi SHA256:${crypto.createHash('sha256').update(Buffer.from(line.split(' ')[1] ?? '', 'base64')).digest('base64').slice(0, 16)}`
  await api.call('POST', '/user/keys', {title, key: line}).catch((e: Error) =>
    fail(`${e.message}; add the root key to your Gitea account by hand, then create the room again: ${line}`))
  if (!await has()) fail(`the root key is not on the Gitea account after adding it: ${line}`)
}
