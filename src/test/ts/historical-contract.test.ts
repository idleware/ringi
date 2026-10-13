// An explicit contract transition keeps old room profiles without accepting legacy heads
// or treating files attached to an agent's message as historical hub contracts.
import {describe, it} from 'node:test'
import type {TestContext} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import '../../main/ts/composition/index.ts'
import {hubPorts} from '../../main/ts/core/hub/ports/index.ts'
import {contractAt} from '../../main/ts/core/hub/rooms/compat.ts'
import {openRoom} from '../../main/ts/core/hub/rooms/rooms.ts'
import {compose} from '../../main/ts/core/hub/protocol/index.ts'
import {gitTransport} from '../../main/ts/adapters/store-git/transport.ts'
import type {Descriptor, Store} from '../../main/ts/core/hub/ports/store.ts'

const legacy = {schema: 'ringi-hub', version: '1.0', protocol: 1, trust: 'asserted', profile: 'a2a-1', capabilities: ['decisions/1', 'profiles/1']}
const canonical = {...legacy, version: '1.2', store: 'git/2'}
const old = 'a'.repeat(40), head = 'b'.repeat(40)
const fake = (past: object = legacy, current: object | null = canonical, ancestor = true): Store => ({
  contractHead: () => head,
  extends: (a: string, b: string) => a === b || ancestor && a === old && b === head,
  contractFile: (rev: string, name: string) => rev === head && name === 'contract.json' && current ? JSON.stringify(current)
    : rev === old && name === 'hub.json' ? JSON.stringify(past) : null,
} as unknown as Store)

const fixture = (t: TestContext) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ringi-historical-contract-'))
  t.after(() => fs.rmSync(root, {recursive: true, force: true}))
  const d: Descriptor = {schema: 'ringi-hub/2', name: 'fixture', trust: 'asserted', store: {type: 'git', path: 'store'}}
  const transport = gitTransport(root, {signer: () => { throw new Error('asserted transition must not construct a Signer') }})
  const at = path.join(root, 'hub', d.name)
  const store = transport.create(at, d, () => ({text: compose('hub fixture', [['To', '*'], ['Kind', 'hub']]),
    files: {'hub.json': JSON.stringify(legacy)}})).store
  return {store, d, at}
}

describe('historical contracts', () => {
  it('refuses a legacy current head until its canonical amendment', t => {
    const {store} = fixture(t)
    assert.throws(() => contractAt(store, 'fixture', store.contractHead()), /has no contract/)
  })

  it('keeps the frozen profile of a room after a real append-only transition', t => {
    const {store, d, at} = fixture(t)
    const base = store.contractHead()
    const profile = fs.readFileSync(path.join(hubPorts().build.resources, 'profiles/a2a-1.json'), 'utf8')
    const genesis = store.createRoom('legacy-room', 'operator', compose('room legacy-room', [['To', '*'], ['Kind', 'room']]),
      {'members.json': JSON.stringify({operator: {role: 'root'}, codex: {role: 'member'}}), 'profile.json': profile})
    const before = store.room('legacy-room')!
    const poison = store.append(before, 'codex', compose('an attachment is not a contract', [['To', 'operator']]),
      [{path: 'hub.json', content: JSON.stringify(legacy), mode: '100644'}])
    const main = store.amendContract('operator', compose('canonical contract', [['To', '*'], ['Kind', 'hub']]),
      {'contract.json': JSON.stringify(canonical)})
    store.updateControl(store.room('legacy-room')!, 'operator',
      compose('contract 1.2', [['To', '*'], ['Kind', 'room'], ['Contract', main]]), {})
    const room = openRoom({name: 'fixture', dir: at, d, store, main, contract: contractAt(store, 'fixture', main), signed: false}, 'legacy-room')!
    assert.equal(room.genesis, genesis)
    assert.equal(room.s.base, base)
    assert.equal(room.contract.version, '1.2')
    assert.equal(room.profile.name, 'a2a-1')
    assert.equal(store.controlFile(room.s, 'profile.json', genesis), profile)
    assert.equal(store.extends(base, main), true)
    assert.equal(contractAt(store, 'fixture', base).version, '1.0')
    assert.throws(() => contractAt(store, 'fixture', poison), /has no contract/)
    assert.equal(store.contractFile(base, 'contract.json'), null, 'no old object was rewritten')
  })

  it('refuses a non-ancestor legacy snapshot', () => {
    assert.throws(() => contractAt(fake(legacy, canonical, false), 'fixture', old), /has no contract/)
  })

  it('applies the same schema, major, protocol and capability gates to the past', () => {
    for (const value of [{...legacy, schema: 'other'}, {...legacy, version: '99.0'}, {...legacy, protocol: '1'}, {...legacy, capabilities: ['unknown/1']}]) {
      assert.throws(() => contractAt(fake(value), 'fixture', old))
    }
  })

  it('requires the current canonical head to pass its gates before reading any legacy snapshot', () => {
    for (const value of [null, {...canonical, schema: 'other'}, {...canonical, version: '99.0'}, {...canonical, protocol: 2}, {...canonical, capabilities: ['unknown/1']}]) {
      assert.throws(() => contractAt(fake(legacy, value), 'fixture', old))
    }
  })
})
