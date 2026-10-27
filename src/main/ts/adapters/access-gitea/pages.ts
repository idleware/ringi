// Controlled page numbers read even server-capped lists to an empty page, without following remote URLs.
import {fail} from '../../lib/index.ts'
import type {Send} from './request.ts'
import type {ApiReply} from '../http/request.ts'

const countOf = (r: ApiReply, previous: number | undefined): number | undefined => {
  const value = r.headers.get('x-total-count')
  if (value === null) return previous
  const count = Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(count)) fail('Gitea returned an inconsistent list count')
  if (previous !== undefined && count !== previous) fail('Gitea returned an inconsistent list count')
  return count
}
const pageOf = async <T>(r: ApiReply, path: string, accept: (x: unknown) => x is T): Promise<T[]> => {
  if (r.status === 404) fail(`Gitea ${path}: no complete list`)
  const page: unknown = await r.json()
  if (!Array.isArray(page) || !page.every(accept)) return fail(`Gitea ${path}: not a list of the requested records`)
  return page
}
const complete = (r: ApiReply, count: number | undefined, length: number) => {
  if (count !== undefined && count !== length) fail('Gitea returned an incomplete list')
  if (r.headers.get('link')?.includes('rel="next"')) fail('Gitea returned an incomplete list')
}
export const pages = async <T>(send: Send, path: string, accept: (x: unknown) => x is T): Promise<T[]> => {
  const all: T[] = []
  let total: number | undefined
  for (let n = 1; n <= 200; n++) {
    const r = await send('GET', `${path}${path.includes('?') ? '&' : '?'}page=${n}&limit=50`)
    const page = await pageOf(r, path, accept)
    total = countOf(r, total)
    if (!page.length) { complete(r, total, all.length); return all }
    all.push(...page)
    if (total !== undefined && all.length > total) fail('Gitea returned an inconsistent list count')
  }
  return fail(`Gitea ${path}: more pages than ringi reads (200)`)
}
