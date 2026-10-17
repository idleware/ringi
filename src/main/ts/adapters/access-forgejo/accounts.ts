// accounts: who an account is on the forge, by its stable id, and every public key it holds, read whole or not at all:
// a key a list leaves out is no proof, so an answer that is not a complete list fails rather than shortens.

import {fail} from '../../lib/index.ts'
import type {Account} from '../../core/hub/ports/access.ts'
import type {Call} from './api.ts'

const PAGE = 50, PAGES = 200
// A public key as the forge and ringi compare it: algorithm and blob, no comment.
export const keyLine = (key: string) => key.trim().split(/\s+/).slice(0, 2).join(' ')

const isUser = (u: {id?: unknown, login?: unknown}): u is {id: number, login: string} => typeof u.id === 'number' && typeof u.login === 'string'
const isKeys = (x: unknown): x is Array<{key: string}> => Array.isArray(x) && x.every(k => typeof (k as {key?: unknown} | null)?.key === 'string')

export const account = async (call: Call, login: string): Promise<Account | null> => {
  const u = await call<{id?: unknown, login?: unknown}>('GET', `/users/${encodeURIComponent(login)}`)
  if (u === null) return null
  if (!isUser(u) || u.login.toLowerCase() !== login.toLowerCase()) return fail(`Forgejo answered for ${login} with no account of that name`)
  return {id: String(u.id), login: u.login}
}
// Page after page until an empty one, whatever page size the forge allows, of the account it still is.
export const accountKeys = async (call: Call, a: Account): Promise<string[]> => {
  const now = await account(call, a.login)
  if (!now || (a.id !== null && now.id !== a.id)) fail(`${a.login} on the forge is not the account it was (${a.id ?? 'no id'})`)
  const all: string[] = []
  for (let page = 1; page <= PAGES; page++) {
    const keys = await call<unknown>('GET', `/users/${encodeURIComponent(a.login)}/keys?page=${page}&limit=${PAGE}`)
    if (!isKeys(keys)) return fail(`Forgejo answered ${a.login}'s keys with something that is not a list of keys`)
    if (!keys.length) return [...new Set(all)]
    all.push(...keys.map(k => keyLine(k.key)))
  }
  return fail(`${a.login} has more keys than ringi reads (${PAGE * PAGES})`)
}
