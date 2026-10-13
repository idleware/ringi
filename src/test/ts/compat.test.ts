// Major 2 and explicit catalogue/wire gates refuse old homes and contracts without rewriting anything.
import {describe, it} from 'node:test'
import assert from 'node:assert/strict'
import '../../main/ts/composition/index.ts'
import {contractAt, descriptorRefusal, endpointRefusal, layoutRefusal} from '../../main/ts/core/hub/rooms/compat.ts'
import type {Descriptor, RoomEndpoint, Store} from '../../main/ts/core/hub/ports/store.ts'
import {storeOf} from '../../main/ts/core/hub/rooms/address.ts'

const genesis = 'a'.repeat(40)
const contract = {schema: 'ringi-hub', version: '2.0', protocol: 1, trust: 'asserted', store: 'git/3', capabilities: ['profiles/1']}
const descriptor: Descriptor = {schema: 'ringi-hub/3', name: 'test', genesis, trust: 'asserted', store: {type: 'git'}, contract: {path: 'contract'}}
const storeWith = (c: object, filename = 'contract.json'): Store => ({contractFile: (_rev: string, name: string) => name === filename ? JSON.stringify(c) : null} as unknown as Store)
const read = (c: object) => contractAt(storeWith(c), 'test', genesis)

describe('compatibility gates', () => {
  it('requires a named store and returns its transport locator', () => {
    assert.deepEqual(storeOf('git+ssh://git@example.test/r.git'), {type: 'git', locator: 'ssh://git@example.test/r.git'})
    assert.deepEqual(storeOf('git+https://example.test/r.git'), {type: 'git', locator: 'https://example.test/r.git'})
    assert.deepEqual(storeOf('git+file:///tmp/r.git'), {type: 'git', locator: 'file:///tmp/r.git'})
    assert.deepEqual(storeOf('postgres://example.test/r'), {type: 'postgres', locator: 'postgres://example.test/r'})
    for (const x of ['ssh://git@example.test/r.git', 'file:///tmp/r.git', 'https://example.test/r.git', 'git@example.test:r.git', 'git+file:///tmp/r.git\n']) assert.throws(() => storeOf(x), /store type|store scheme/)
  })
  it('requires major 2, protocol 1, declared layout and supported capabilities', () => {
    assert.equal(read(contract).store, 'git/3')
    assert.throws(() => read({...contract, version: '1.2'}), /supports 2.x/)
    assert.throws(() => read({...contract, version: '3.0'}), /upgrade ringi/)
    assert.throws(() => read({...contract, protocol: 2}), /speaks protocol 2/)
    assert.throws(() => read({...contract, capabilities: ['decisions/1']}), /requires decisions/)
    assert.throws(() => read({...contract, capabilities: ['teleport/1']}), /cannot enforce/)
    assert.throws(() => read({...contract, store: undefined}), /explicit store layout/)
    assert.equal(layoutRefusal('test', 'git/3', 'git/3'), null)
    assert.match(layoutRefusal('test', 'git/2', 'git/3')!, /reads git\/3/)
  })
  it('does not infer a contract from a historical filename, even on an ancestor', () => {
    const s = storeWith(contract, 'hub.json')
    s.contractHead = () => 'b'.repeat(40)
    s.extends = () => true
    assert.throws(() => contractAt(s, 'test', genesis), /has no contract/)
  })
  it('requires catalogue pins and safe paths and refuses every old descriptor', () => {
    assert.equal(descriptorRefusal(descriptor, 'test'), null)
    for (const d of [{...descriptor, schema: 'ringi-hub/2'}, {...descriptor, genesis: undefined}, {...descriptor, root: 'asserted has no root'},
      {...descriptor, trust: 'signed', root: undefined}, {...descriptor, contract: {path: '../old'}}, {...descriptor, name: 'elsewhere'}]) {
      assert.match(descriptorRefusal(d as unknown as Descriptor, 'test')!, /descriptor is not one/)
    }
  })
  it('requires an explicit endpoint with matching full hub/room genesis pins', () => {
    const endpoint: RoomEndpoint = {schema: 'ringi-room/1', name: 'room', hubGenesis: genesis, genesis: 'b'.repeat(40), store: {path: 'store'}}
    assert.equal(endpointRefusal(descriptor, 'room', endpoint), null)
    for (const e of [{...endpoint, genesis: 'b'.repeat(12)}, {...endpoint, hubGenesis: 'c'.repeat(40)}, {...endpoint, name: 'alias'}, {...endpoint, store: {path: '../old'}}]) {
      assert.match(endpointRefusal(descriptor, 'room', e)!, /refusing another room/)
    }
  })
})
