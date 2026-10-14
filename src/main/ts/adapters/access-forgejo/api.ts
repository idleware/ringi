// api: Forgejo's HTTP API as one organisation's space: where it is, the operator's token, and calls that fail with
// what the forge said.

import fs from 'node:fs'
import {fail} from '../../lib/index.ts'

export type Call = <T>(method: string, path: string, body?: unknown) => Promise<T | null>

// The operator's API token: a file only its owner reads; ringi never writes one.
const token = (authRef: string): string => {
  const st = fs.statSync(authRef, {throwIfNoEntry: false}) ?? fail(`no Forgejo token file ${authRef}`)
  if (st.mode & 0o077) fail(`${authRef} is readable by others; chmod 600 it`)
  return fs.readFileSync(authRef, 'utf8').trim() || fail(`${authRef} holds no token`)
}
const loopback = (host: string) => host === 'localhost' || host === '127.0.0.1'
// A space is https (plain http only on this machine's loopback) and names no credentials, query or fragment: the token
// is the auth file's alone.
export const space = (locator: string): {api: string, org: string} => {
  const u = new URL(locator)
  const org = u.pathname.replace(/^\/+|\/+$/g, '')
  if (!(u.protocol === 'https:' || (u.protocol === 'http:' && loopback(u.hostname)))) fail('a Forgejo space is reached over https')
  if (u.username || u.password || u.search || u.hash) fail('a Forgejo space names no credentials, query or fragment; the token is in the auth file')
  if (!/^[A-Za-z0-9_.-]+$/.test(org)) fail(`a Forgejo space is one organisation: ${locator}`)
  return {api: `${u.origin}/api/v1`, org}
}
// A missing thing read is none; any other failure is the forge's words.
export const caller = (api: string, authRef: string): Call => async <T>(method: string, path: string, body?: unknown): Promise<T | null> => {
  const r = await fetch(api + path, {method, redirect: 'error', headers: {Authorization: `token ${token(authRef)}`, 'Content-Type': 'application/json'},
    ...(body === undefined ? {} : {body: JSON.stringify(body)})})
  if (r.status === 404 && method === 'GET') return null
  if (!r.ok) fail(`Forgejo ${method} ${path}: ${r.status} ${(await r.text()).slice(0, 200)}`)
  return r.status === 204 ? null : await r.json() as T
}
// git+ssh for an ssh:// URL Forgejo reports, or for its scp form (git@host:org/repo.git).
export const typed = (ssh: string): string => {
  const scp = /^([^@/]+@[^:/]+):(.+)$/.exec(ssh)
  return scp ? `git+ssh://${scp[1]}/${scp[2]}` : `git+${ssh}`
}
