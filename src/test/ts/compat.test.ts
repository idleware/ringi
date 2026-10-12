// The gates a hub passes before ringi reads it, and what each refusal tells the operator to do. Nothing is migrated.
import {describe, it} from 'node:test'
import assert from 'node:assert/strict'
import '../../main/ts/composition/index.ts'
import {contractAt, descriptorRefusal, layoutRefusal} from '../../main/ts/core/hub/rooms/compat.ts'
import {gitTransport} from '../../main/ts/adapters/transport-git/transport.ts'
import type {Descriptor, Store} from '../../main/ts/core/hub/ports/store.ts'

const contract = {schema: 'ringi-hub', version: '1.2', protocol: 1, trust: 'asserted', store: 'git/2', capabilities: ['decisions/1', 'profiles/1']}
const storeWith = (c: object): Store => ({contractFile: (_rev: string, name: string) => name === 'contract.json' ? JSON.stringify(c) : null} as unknown as Store)
const read = (c: object) => contractAt(storeWith(c), 'old', 'r')

describe('compatibility gates', () => {
  it('reads a contract it knows, and one made before the store field', () => {
    assert.equal(read(contract).store, 'git/2')
    const {store: _, ...before} = contract
    assert.equal(read({...before, version: '1.1'}).version, '1.1')
  })

  it('refuses another store layout, named by the contract or found in the store', () => {
    assert.equal(layoutRefusal('old', 'git/2', 'git/2'), null)
    assert.match(layoutRefusal('old', 'git/1', 'git/2')!, /hub old keeps its store as git\/1; this ringi .* reads git\/2: upgrade ringi if the hub is newer, or make a new hub beside it/)
    // A contract that names no layout: the git store looks. ringi 0.1 kept a room as branches under `<room>/`.
    const t = gitTransport('/nowhere')
    const branches = (names: string[]) => ({roomBranches: () => names}) as unknown as Store
    assert.equal(t.layoutOf!(branches(['fix-badge', 'r@0123abcd'])), 'git/2')
    assert.equal(t.layoutOf!(branches(['old/control', 'old/log/codex'])), 'git/1')
  })

  it('refuses another protocol or contract major, saying what to do', () => {
    assert.throws(() => read({...contract, protocol: 2}), /speaks protocol 2; this ringi .* speaks 1: upgrade ringi/)
    assert.throws(() => read({...contract, version: '0.9'}), /follows contract version 0\.9; .*: make a new hub beside it \(ringi hub create <name>\), or a new root branch on a forge; ringi does not migrate/)
    assert.throws(() => read({...contract, capabilities: ['teleport/1']}), /requires teleport\/1, which this ringi .* cannot enforce/)
  })

  it('refuses a descriptor of another schema', () => {
    const d = {schema: 'ringi-hub/2', name: 'old', trust: 'asserted', store: {type: 'git', path: 'store'}} as Descriptor
    assert.equal(descriptorRefusal(d, 'old'), null)
    assert.match(descriptorRefusal({...d, schema: 'ringi-hub/1'} as unknown as Descriptor, 'old')!, /its descriptor is not one this ringi .* reads; make a new hub beside it/)
  })
})
