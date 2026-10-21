// Authenticated requests stay on the space's API; redirects and hot retries are never followed.
import fs from 'node:fs'
import {fail} from '../../lib/index.ts'

export type Send = (method: string, path: string, body?: unknown) => Promise<Response>
const token = (file: string): string => {
  const st = fs.statSync(file, {throwIfNoEntry: false}) ?? fail(`no Gitea token file ${file}`)
  if (!st.isFile() || st.mode & 0o077) fail(`${file} must be a file only its owner reads; chmod 600 it`)
  return fs.readFileSync(file, 'utf8').trim() || fail(`${file} holds no token`)
}
export const requester = (api: string, authRef: string): Send => async (method, path, body) => {
  const r = await fetch(api + path, {method, redirect: 'error', headers: {
    Authorization: `token ${token(authRef)}`, 'Content-Type': 'application/json'},
  ...(body === undefined ? {} : {body: JSON.stringify(body)})})
  if (!r.ok && !(method === 'GET' && r.status === 404)) {
    const retry = r.headers.get('retry-after')
    fail(`Gitea ${method} ${path}: ${r.status} ${(await r.text()).slice(0, 200)}${retry ? '; retry after ' + retry + ' s' : ''}`)
  }
  return r
}
