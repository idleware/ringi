// The same adversarial creation/retry/delete contract on each provider's own API model.
import {it} from 'node:test'
import type {TestContext} from 'node:test'
import assert from 'node:assert/strict'
import type {RoomProvision} from '../../main/ts/core/hub/ports/access.ts'
import type {fixtureAccess} from './access-fixture.ts'

type Fixture = {access: ReturnType<typeof fixtureAccess>, repos: Map<string, {id: number, chat?: boolean}>, writes: string[]}
export const identityCases = (make: (t: TestContext) => Fixture | Promise<Fixture>) => {
  it('refuses unknown existing repositories even when empty, and refuses deletion without a saved id', async t => {
    const f = await make(t)
    await f.access.ensureRoom('foreign', {bind() {}, checkChat() {assert.fail('no chat')}})
    const before = [...f.writes]
    await assert.rejects(f.access.ensureRoom('foreign'), /not this room's saved repository; nothing is adopted; if an interrupted create of yours made it, delete it on the host and create again/)
    await assert.rejects(f.access.deleteServer('foreign'), /no stable repository id/)
    assert.deepEqual(f.writes, before)
  })
  it('binds the POST id before policy writes and resumes only that object after interruption', async t => {
    const f = await make(t)
    let id: string | undefined
    await assert.rejects(f.access.ensureRoom('retry', {bind(result) {
      assert.equal(f.writes.length, 1, 'only repository POST precedes the durable bind')
      id = result.repositoryId
      throw Error('fixture crash after durable id')
    }, checkChat() {assert.fail('no chat')}}), /fixture crash/)
    const intent: RoomProvision = {repositoryId: id, bind: result => assert.equal(result.repositoryId, id), checkChat() {assert.fail('no chat')}}
    await f.access.ensureRoom('retry', intent)
    assert.equal(f.writes.filter(w => /^POST \/orgs\/.+\/repos$/.test(w)).length, 1)
    f.repos.get('retry')!.id++
    const before = [...f.writes]
    await assert.rejects(f.access.ensureRoom('retry', intent), /repository id changed/)
    await assert.rejects(f.access.deleteServer('retry', id!), /repository id changed/)
    assert.deepEqual(f.writes, before)
  })
  it('checks an existing chat before changing any policy, and refuses a missing saved object without recreating it', async t => {
    const f = await make(t)
    await f.access.ensureRoom('chat')
    const r = f.repos.get('chat')!
    r.chat = true
    const before = [...f.writes]
    let checked = 0
    const intent: RoomProvision = {repositoryId: String(r.id), bind() {}, checkChat() {checked++; throw Error('foreign genesis')}}
    await assert.rejects(f.access.ensureRoom('chat', intent), /foreign genesis/)
    assert.equal(checked, 1); assert.deepEqual(f.writes, before)
    await f.access.ensureRoom('chat', {...intent, checkChat() {checked++}})
    assert.equal(checked, 2)
    f.repos.delete('chat')
    const done = [...f.writes]
    await assert.rejects(f.access.ensureRoom('chat', intent), /lost its saved repository/)
    assert.deepEqual(f.writes, done)
  })
}
