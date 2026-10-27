// request: one call to GitHub's REST API with the operator's token, and what its answer means: a thing that is not
// there, a refusal with GitHub's words and when its rate limit lifts, or the value.

import fs from 'node:fs'
import {fail} from '../../lib/index.ts'
import {apiRequest} from '../http/request.ts'
import type {ApiReply} from '../http/request.ts'

// The operator's API token: a file only its owner reads; ringi never writes one.
const token = (authRef: string): string => {
  const st = fs.statSync(authRef, {throwIfNoEntry: false}) ?? fail(`no GitHub token file ${authRef}`)
  if (st.mode & 0o077) fail(`${authRef} is readable by others; chmod 600 it`)
  return fs.readFileSync(authRef, 'utf8').trim() || fail(`${authRef} holds no token`)
}
// A refusal says what GitHub said, and when a rate limit is the reason, when it lifts; ringi does not wait for it.
const lifts = (r: ApiReply): string | null => {
  const reset = r.headers.get('x-ratelimit-remaining') === '0' ? r.headers.get('x-ratelimit-reset') : null
  return r.headers.get('retry-after') ?? (reset ? `${Math.max(0, Number(reset) - Math.floor(Date.now() / 1000))}` : null)
}
const limited = (r: ApiReply, text: string) => r.status === 429 || (r.status === 403 && /rate limit/i.test(text))
export const refusal = async (r: ApiReply, method: string, path: string): Promise<never> => {
  const text = (await r.text()).slice(0, 200), retry = lifts(r)
  const when = retry ? `; its rate limit lifts in ${retry} s, try again then` : limited(r, text) ? '; GitHub names no time its rate limit lifts' : ''
  return fail(`GitHub ${method} ${path}: ${r.status} ${text}${when}`)
}
export type Request = (method: string, url: string, body?: unknown) => Promise<ApiReply>
export const requester = (authRef: string): Request => (method, url, body) => {
  const secret = token(authRef)
  return apiRequest(`GitHub ${method}`, secret, url, {method, headers: {
    Authorization: `Bearer ${secret}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json'},
  ...(body === undefined ? {} : {body: JSON.stringify(body)})})
}
// A missing thing read is none; any other failure is GitHub's words.
export const answer = async <T>(r: ApiReply, method: string, path: string): Promise<T | null> => {
  if (r.status === 404 && method === 'GET') return null
  if (!r.ok) return refusal(r, method, path)
  return r.status === 204 || r.headers.get('content-length') === '0' ? null : await r.json() as T
}
