// api: GitHub's REST API as one organisation's space: where it is, the operator's token, and calls that fail with
// what GitHub said, its rate limit included. Lists are read page by page through their `Link` header.

import {fail} from '../../lib/index.ts'
import {answer, refusal, requester} from './request.ts'
import type {Request} from './request.ts'

export type Call = <T>(method: string, path: string, body?: unknown) => Promise<T | null>
export type Pages = <T>(path: string) => Promise<T[]>

const loopback = (host: string) => host === 'localhost' || host === '127.0.0.1'
// A space by its canonical address (`github://github.com/org`): github.com's API is api.github.com, a GitHub Enterprise
// server's is under /api/v3; over https, plain http only on this machine's loopback.
export const space = (address: string): {api: string, org: string, host: string} => {
  const u = new URL(address)
  if (u.protocol !== 'github:') fail(`${address} is not a GitHub space`)
  const org = u.pathname.replace(/^\/+|\/+$/g, '')
  if (u.username || u.password || u.search || u.hash) fail('a GitHub space names no credentials, query or fragment; the token is in the token file')
  if (!/^[A-Za-z0-9-]+$/.test(org)) fail(`a GitHub space is one organisation: ${address}`)
  if (u.host === 'github.com') return {api: 'https://api.github.com', org, host: u.hostname}
  return {api: `${loopback(u.hostname) ? 'http' : 'https'}://${u.host}/api/v3`, org, host: u.hostname}
}
const MAX_PAGES = 100
const next = (link: string | null): string | null => /<([^>]+)>;\s*rel="next"/.exec(link ?? '')?.[1] ?? null
// Whether a URL is this API's own: the same scheme, host and port, no credentials, and under its path (`/api/v3/` on a
// GitHub Enterprise server, not `/api/v30`). The token goes nowhere else.
const ownUrl = (api: string, url: string): boolean => {
  let u: URL
  try { u = new URL(url, api) } catch { return false }
  const base = new URL(api), root = base.pathname.replace(/\/+$/, '')
  return u.origin === base.origin && !u.username && !u.password && (!root || u.pathname === root || u.pathname.startsWith(root + '/'))
}
// One page of a list, and where the next is; one that is not a list, or sent elsewhere, is no answer.
const page = async <T>(request: Request, api: string, url: string, path: string): Promise<{items: T[], next: string | null}> => {
  if (!ownUrl(api, url)) fail(`GitHub ${path} sent the next page to another place; nothing more is read`)
  const r = await request('GET', url)
  if (!r.ok) return refusal(r, 'GET', path)
  const items: unknown = await r.json()
  if (!Array.isArray(items)) fail(`GitHub answered ${path} with something that is not a list`)
  return {items: items as T[], next: next(r.headers.get('link'))}
}
export const caller = (api: string, authRef: string): {call: Call, pages: Pages} => {
  const request = requester(authRef)
  const call: Call = async <T>(method: string, path: string, body?: unknown) => answer<T>(await request(method, api + path, body), method, path)
  // Every page of a list, or a failure: a list cut short is no answer.
  const pages: Pages = async <T>(path: string): Promise<T[]> => {
    const all: T[] = []
    let url: string | null = `${api}${path}${path.includes('?') ? '&' : '?'}per_page=100`
    for (let n = 0; url; n++) {
      if (n >= MAX_PAGES) fail(`GitHub ${path} has more pages than ringi reads (${MAX_PAGES})`)
      const got: {items: T[], next: string | null} = await page<T>(request, api, url, path)
      all.push(...got.items)
      url = got.next && new URL(got.next, api).href
    }
    return all
  }
  return {call, pages}
}
