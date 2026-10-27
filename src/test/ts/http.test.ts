// Request and output boundaries with dummy credentials and process-local fetch/stream fixtures only.
import {it} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {apiRequest} from '../../main/ts/adapters/http/request.ts'
import {caller as forgejo} from '../../main/ts/adapters/access-forgejo/api.ts'
import {caller as gitea} from '../../main/ts/adapters/access-gitea/api.ts'
import {caller as github} from '../../main/ts/adapters/access-github/api.ts'

const secret = 'fixture-api-secret-917264'
const url = 'https://fixture.invalid/api', limits = {timeoutMs: 30, bodyBytes: 64, errorBytes: 32}
it('redacts reflected tokens and escapes controls in every provider error and retry header', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ringi-http-')), token = path.join(base, 'token')
  t.after(() => fs.rmSync(base, {recursive: true, force: true})); fs.writeFileSync(token, secret, {mode: 0o600})
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    assert.equal(init.redirect, 'error'); assert.ok(init.signal instanceof AbortSignal)
    return new Response(`${secret}\x1b[2J\nAuthorization: Bearer ${secret}\r`, {status: 429, headers: {'retry-after': secret + '\x1b[0m'}})
  })
  const calls = [forgejo(url, token), gitea(url, token).call, github(url, token).call]
  for (const call of calls) {
    await assert.rejects(call('POST', '/protected'), (e: Error) => {
      assert.ok(!e.message.includes(secret)); assert.ok(!/[\x00-\x1f\x7f-\x9f]/.test(e.message))
      assert.match(e.message, /redacted/); assert.match(e.message, /\\x1b/); return true
    })
  }
})
it('enforces a deadline even when fetch never settles or the response body stalls', async t => {
  let signal: AbortSignal | undefined
  const fetch = t.mock.method(globalThis, 'fetch', (_url: string, init: RequestInit) => {
    signal = init.signal!; return new Promise<Response>(() => {})
  })
  await assert.rejects(apiRequest('fixture', secret, url, {}, limits), /API request timed out/)
  assert.equal(signal!.aborted, true)
  let cancelled = false
  fetch.mock.mockImplementation(async () => new Response(new ReadableStream({cancel() {cancelled = true}})))
  await assert.rejects(apiRequest('fixture', secret, url, {}, limits), /API request timed out/)
  assert.equal(cancelled, true)
})
it('bounds declared and streamed response bytes before allocation or JSON parsing', async t => {
  let response: Response, cancelled = false
  t.mock.method(globalThis, 'fetch', async () => response)
  const stream = (text: string) => new ReadableStream({start(c) {c.enqueue(new TextEncoder().encode(text))}, cancel() {cancelled = true}})
  for (const declared of [false, true]) {
    cancelled = false
    response = new Response(stream('x'.repeat(65)), {headers: declared ? {'content-length': '1000000000'} : {}})
    await assert.rejects(apiRequest('fixture', secret, url, {}, limits), /API response exceeds 64 bytes/)
    assert.equal(cancelled, true)
  }
  response = new Response('x'.repeat(33), {status: 500})
  await assert.rejects(apiRequest('fixture', secret, url, {}, limits), /API response exceeds 32 bytes/)
})
it('keeps raw JSON parser snippets and fetch rejection text out of diagnostics', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('invalid ' + secret))
  const r = await apiRequest('fixture', secret, url, {}, limits)
  await assert.rejects(r.json(), (e: Error) => e.message === 'fixture: invalid API JSON')
  fetch.mock.mockImplementation(async () => {throw Error(secret + '\x1b[2J')})
  await assert.rejects(apiRequest('fixture', secret, url, {}, limits), (e: Error) => e.message === 'fixture: API request failed')
})
it('returns bounded valid JSON and empty responses with their pagination metadata', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('[{"id":1}]', {headers: {link: '<https://fixture.invalid/page2>; rel="next"'}}))
  const r = await apiRequest('fixture', secret, url, {}, limits)
  assert.deepEqual(await r.json(), [{id: 1}]); assert.match(r.headers.get('link')!, /page2/)
  fetch.mock.mockImplementation(async () => new Response(null, {status: 204}))
  const empty = await apiRequest('fixture', secret, url, {}, limits)
  assert.equal(empty.status, 204); assert.equal(await empty.text(), '')
})
