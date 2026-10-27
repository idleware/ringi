// api: Forgejo's HTTP API as one organisation's space: where it is, the operator's token, and calls that fail with
// what the forge said.

import fs from 'node:fs'
import {fail} from '../../lib/index.ts'
import {apiRequest} from '../http/request.ts'

export type Call = <T>(method: string, path: string, body?: unknown) => Promise<T | null>

// The operator's API token: a file only its owner reads; ringi never writes one.
const token = (authRef: string): string => {
  const st = fs.statSync(authRef, {throwIfNoEntry: false}) ?? fail(`no Forgejo token file ${authRef}`)
  if (st.mode & 0o077) fail(`${authRef} is readable by others; chmod 600 it`)
  return fs.readFileSync(authRef, 'utf8').trim() || fail(`${authRef} holds no token`)
}
const loopback = (host: string) => host === 'localhost' || host === '127.0.0.1'
// A space by its canonical address (`forgejo://forge.example/org`): its API is reached over https, plain http only on
// this machine's loopback; the address names no credentials, query or fragment: the token is the token file's alone.
export const space = (address: string): {api: string, org: string} => {
  const u = new URL(address)
  if (u.protocol !== 'forgejo:') fail(`${address} is not a Forgejo space`)
  const org = u.pathname.replace(/^\/+|\/+$/g, '')
  if (u.username || u.password || u.search || u.hash) fail('a Forgejo space names no credentials, query or fragment; the token is in the token file')
  if (!/^[A-Za-z0-9_.-]+$/.test(org)) fail(`a Forgejo space is one organisation: ${address}`)
  return {api: `${loopback(u.hostname) ? 'http' : 'https'}://${u.host}/api/v1`, org}
}
// A missing thing read is none; any other failure is the forge's words.
export const caller = (api: string, authRef: string): Call => async <T>(method: string, path: string, body?: unknown): Promise<T | null> => {
  const secret = token(authRef)
  const r = await apiRequest(`Forgejo ${method} ${path}`, secret, api + path, {method, headers: {Authorization: `token ${secret}`, 'Content-Type': 'application/json'},
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
