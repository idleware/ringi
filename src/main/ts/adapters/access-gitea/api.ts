// Gitea's API. Paginated account lists are read to an empty page; protection lists are unpaginated in the supported API.
import {fail} from '../../lib/index.ts'
import {canonical, parseAddress} from '../../core/hub/rooms/address.ts'
import {requester} from './request.ts'
import {pages} from './pages.ts'
import type {Send} from './request.ts'

export type Call = <T>(method: string, path: string, body?: unknown) => Promise<T | null>
export type Api = {call: Call, pages: <T>(path: string, accept: (x: unknown) => x is T) => Promise<T[]>}
export const space = (locator: string): {api: string, org: string} => {
  const a = parseAddress(locator, 'create')
  if (a.kind !== 'space' || a.provider !== 'gitea') return fail(`${locator} is not a Gitea space`)
  const u = new URL(canonical(a)), local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
  return {api: `${local ? 'http' : 'https'}://${u.host}/api/v1`, org: encodeURIComponent(a.space)}
}
const reply = async <T>(send: Send, method: string, path: string, body?: unknown): Promise<T | null> => {
  const r = await send(method, path, body)
  if ([404, 204].includes(r.status) || r.headers.get('content-length') === '0') return null
  if (r.headers.get('link')?.includes('rel="next"')) fail(`Gitea ${path}: this protection API must return the whole list`)
  return await r.json() as T
}
export const caller = (api: string, authRef: string): Api => {
  const send = requester(api, authRef)
  return {call: (method, path, body) => reply(send, method, path, body), pages: (path, accept) => pages(send, path, accept)}
}
