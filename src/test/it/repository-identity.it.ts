// Real provider IDs on disposable local servers: foreign empty repos, interrupted create and name reuse.
import {describe, it} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {forgejoAccess} from '../../main/ts/adapters/access-forgejo/index.ts'
import {giteaAccess} from '../../main/ts/adapters/access-gitea/index.ts'
import type {ProvisionedRoom, RoomProvision} from '../../main/ts/core/hub/ports/access.ts'
import {dockerAvailable, ORG, server} from './server.ts'

describe('provider repository identity in docker', {skip: !dockerAvailable() && 'docker is not available'}, () => {
  for (const kind of ['forgejo', 'gitea'] as const) it(`${kind}: refuses foreign empty objects and replacements, resumes the saved id`, async t => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ringi-it-${kind}-identity-`)))
    t.after(() => fs.rmSync(base, {recursive: true, force: true}))
    const s = await server(t, kind, base), access = (kind === 'forgejo' ? forgejoAccess : giteaAccess)(s.space, s.tokenFile)
    const create = async (name: string) => {
      const r = await s.api<{id: number}>('POST', `/orgs/${ORG}/repos`, {name, private: true, auto_init: false, default_branch: 'main'})
      assert.equal(r.status, 201); return r.body.id
    }
    const noChat = () => assert.fail('empty fixture must have no chat')
    const foreign = await create('foreign')
    await assert.rejects(access.ensureRoom('foreign', {bind() {assert.fail('foreign id must not bind')}, checkChat: noChat}), /not this room's saved repository/)
    assert.deepEqual((await s.api('GET', `/repos/${ORG}/foreign/branch_protections`)).body, [])
    await assert.rejects(access.deleteServer('foreign', ''), /no stable repository id/)
    assert.equal((await s.api<{id: number}>('GET', `/repos/${ORG}/foreign`)).body.id, foreign)
    const receipt = path.join(base, 'creation-receipt.json')
    await assert.rejects(access.ensureRoom('retry', {bind(result) {
      fs.writeFileSync(receipt, JSON.stringify(result), {mode: 0o600})
      throw Error('fixture interrupted after durable binding')
    }, checkChat: noChat}), /fixture interrupted/)
    assert.deepEqual((await s.api('GET', `/repos/${ORG}/retry/branch_protections`)).body, [])
    const saved: ProvisionedRoom = JSON.parse(fs.readFileSync(receipt, 'utf8'))
    const intent: RoomProvision = {repositoryId: saved.repositoryId, bind: result => assert.deepEqual(result, saved), checkChat: noChat}
    assert.deepEqual(await access.ensureRoom('retry', intent), {address: saved.address})
    assert.equal(String((await s.api<{id: number}>('GET', `/repos/${ORG}/retry`)).body.id), saved.repositoryId)
    assert.ok((await s.api<unknown[]>('GET', `/repos/${ORG}/retry/branch_protections`)).body.length > 0)
    // Only this test's own object is removed to simulate host-side name reuse.
    assert.equal((await s.api('DELETE', `/repos/${ORG}/retry`)).status, 204)
    const replacement = await create('retry')
    assert.notEqual(String(replacement), saved.repositoryId)
    await assert.rejects(access.ensureRoom('retry', intent), /repository id changed/)
    await assert.rejects(access.deleteServer('retry', saved.repositoryId), /repository id changed/)
    assert.equal((await s.api<{id: number}>('GET', `/repos/${ORG}/retry`)).body.id, replacement)
    assert.deepEqual((await s.api('GET', `/repos/${ORG}/retry/branch_protections`)).body, [])
  })
})
