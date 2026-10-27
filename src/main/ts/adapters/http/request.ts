// Shared HTTP mechanics for access adapters: one deadline covers headers and bounded body consumption. No retries.
import {Fail, fail} from '../../lib/index.ts'
import {responseBody} from './body.ts'
import {diagnostic} from './diagnostic.ts'

export type ApiReply = Pick<Response, 'status' | 'ok' | 'headers' | 'text' | 'json'>
type Limits = {timeoutMs?: number, bodyBytes?: number, errorBytes?: number}
const reply = (r: Response, raw: string, secret: string, label: string): ApiReply => {
  const headers = new Headers(r.headers)
  for (const name of ['retry-after', 'x-ratelimit-reset']) {
    const value = headers.get(name)
    if (value !== null) headers.set(name, diagnostic(value, secret).slice(0, 200))
  }
  return {status: r.status, ok: r.ok, headers, text: async () => diagnostic(raw, secret), json: async () => {
    try {return JSON.parse(raw)} catch {return fail(`${label}: invalid API JSON`)}
  }}
}
export const apiRequest = async (label: string, secret: string, url: string, init: RequestInit, limits: Limits = {}): Promise<ApiReply> => {
  const timeout = limits.timeoutMs ?? 15000, bodyBytes = limits.bodyBytes ?? 2 * 1024 * 1024, errorBytes = limits.errorBytes ?? 8192
  if (![timeout, bodyBytes, errorBytes].every(n => Number.isSafeInteger(n) && n > 0) || !secret) fail('invalid API request limits or token')
  const controller = new AbortController()
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined, timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {timer = setTimeout(() => {controller.abort(); reject(new Fail('API request timed out'))}, timeout)})
  const request = async () => {
    const r = await fetch(url, {...init, redirect: 'error', signal: controller.signal})
    try {
      const raw = await responseBody(r, r.ok ? bodyBytes : errorBytes, controller.signal, r => {reader = r})
      return reply(r, raw, secret, label)
    } finally {void reader?.cancel().catch(() => {})}
  }
  try {return await Promise.race([request(), deadline])} catch (e) {
    if (controller.signal.aborted) return fail(`${label}: API request timed out`)
    if (e instanceof Fail) return fail(`${label}: ${e.message}`)
    return fail(`${label}: API request failed`)
  } finally {
    clearTimeout(timer); controller.abort()
    void reader?.cancel().catch(() => {})
  }
}
