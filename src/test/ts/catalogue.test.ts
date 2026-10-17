import {describe, it} from 'node:test'
import assert from 'node:assert/strict'
import {roomCatalogue} from '../../main/ts/core/hub/rooms/catalogue-v2.ts'
import {registrationContext, registrationId, registrationKey} from '../../main/ts/core/hub/rooms/room-registration.ts'
import type {RegistrationOwner, ReservationRequest} from '../../main/ts/core/hub/rooms/room-registration.ts'
import {parseAddress} from '../../main/ts/core/hub/rooms/address.ts'
import type {LocalState} from '../../main/ts/core/hub/ports/state.ts'
import type {RoomDirectory, RoomFiles} from '../../main/ts/core/hub/ports/location.ts'
import type {RoomEndpointV2} from '../../main/ts/core/hub/ports/store.ts'

const clone = <T>(value: T): T => structuredClone(value)
const owner: RegistrationOwner = {name: 'local', genesis: 'a'.repeat(40), trust: 'asserted'}
const endpoint = (address = 'local://fix', identity = 'inode-1'): RoomEndpointV2 => ({
  schema: 'ringi-room/2', address, name: 'fix', hubGenesis: owner.genesis, genesis: 'b'.repeat(40), trust: 'asserted',
  location: {directory: {path: '/repos/' + identity, identity}, generation: 'generation-1'}, store: {path: 'store'},
})
const request = (): ReservationRequest => ({owner, operation: 'create-1', parameters: {invitees: [{id: 'invite-1', mode: 'account', principal: 'alice'}]}})
const choose = () => ({address: 'local://fix', name: 'fix', generation: 'generation-1'})
const fixture = () => {
  const records = new Map<string, unknown>(), checks: string[] = [], directories = new Map<string, RoomDirectory>()
  const key = (parts: readonly string[]) => parts.join('/')
  const state: LocalState = {root: '/state', ensure() {}, locked: (_name, fn) => fn(),
    read: (parts, dflt) => records.has(key(parts)) ? clone(records.get(key(parts))) as typeof dflt : dflt,
    write: (parts, value) => { records.set(key(parts), clone(value)) },
    remove: () => { throw Error('catalogue must not purge state') },
    list: parts => [...new Set([...records.keys()].filter(k => k.startsWith(key(parts) + '/')).map(k => k.slice(key(parts).length + 1).split('/')[0]))].sort(),
    place: () => { throw Error('catalogue must not allocate a filesystem path') },
  }
  const files: RoomFiles = {canonical: p => directories.get(p) ?? null,
    check: d => { checks.push(d.identity) }, createLeaf: () => { throw Error('not a create action') }, purge: () => { throw Error('not a purge action') }}
  return {state, records, checks, directories, files, catalogue: roomCatalogue(state)}
}

describe('explicit E8 room catalogue', () => {
  it('uses opaque keys from the entire canonical address and rejects input aliases before hashing', () => {
    const a = registrationId('forgejo://one/space/fix'), b = registrationId('forgejo://two/space/fix')
    assert.notEqual(a, b)
    assert.deepEqual(registrationKey(a), ['catalogue', 'rooms', a])
    assert.throws(() => registrationId('gh://github.com/space/fix'), /canonical/)
    assert.throws(() => registrationId('fix'), /canonical/)
  })

  it('retains a durable create target, invitation parameters and generation across a restart', () => {
    const f = fixture(), input = request()
    let calls = 0
    const first = f.catalogue.reserve(input, () => { calls++; return choose() })
    const retry = roomCatalogue(f.state).reserve({...input, parameters: {invitees: [{principal: 'alice', mode: 'account', id: 'invite-1'}]}}, () => { throw Error('must not redraw room') })
    assert.deepEqual(retry, first)
    assert.equal(calls, 1)
    assert.equal(first.phase, 'reserved')
    assert.throws(() => f.catalogue.select(parseAddress('fix', 'lookup'), f.files), /not complete/)
    const changed = request(); changed.parameters.invitees = [{id: 'invite-2', mode: 'account', principal: 'alice'}]
    assert.throws(() => f.catalogue.reserve(changed, choose), /changed its parameters/)
    assert.equal(f.records.size, 1)
  })

  it('activates only its exact reservation and preserves the completed operation for retries', () => {
    const f = fixture(), reserved = f.catalogue.reserve(request(), choose), e = endpoint()
    assert.throws(() => f.catalogue.install(owner, e, 'another-operation'), /does not match/)
    assert.throws(() => f.catalogue.install(owner, {...e, location: {...e.location, generation: 'changed'}}, 'create-1'), /does not match/)
    const active = f.catalogue.install(owner, e, 'create-1')
    assert.equal(active.id, reserved.id)
    assert.equal(active.phase, 'active')
    assert.deepEqual(f.catalogue.reserve(request(), () => { throw Error('must not create another repository') }), active)
    assert.throws(() => f.catalogue.install(owner, e, 'different-operation'), /does not own/)
    assert.deepEqual(f.catalogue.select(parseAddress('fix', 'lookup'), f.files), active)
    assert.deepEqual(registrationContext(active), [active.id, e.address, owner.genesis, e.genesis, e.location.generation])
    assert.throws(() => registrationContext(reserved), /no active reader/)
  })

  it('finds names across all adopted hubs and requires a full address on ambiguity', () => {
    const f = fixture(), e1 = endpoint('forgejo://one/space/fix'), e2 = endpoint('forgejo://two/space/fix', 'inode-2')
    const secondOwner = {...owner, name: 'other', genesis: 'c'.repeat(40)}
    f.catalogue.install(owner, e1)
    f.catalogue.install(secondOwner, {...e2, hubGenesis: secondOwner.genesis})
    assert.throws(() => f.catalogue.select(parseAddress('fix', 'lookup'), f.files), /ambiguous.*forgejo:\/\/one.*forgejo:\/\/two/)
    assert.equal(f.catalogue.select(parseAddress(e2.address, 'lookup'), f.files).owner.name, 'other')
    assert.throws(() => f.catalogue.select(parseAddress('missing', 'lookup'), f.files), /unknown room/)
  })

  it('never overwrites an occupied address when genesis, incarnation or hub pins change', () => {
    const f = fixture(), e = endpoint(), first = f.catalogue.install(owner, e)
    assert.throws(() => f.catalogue.install(owner, {...e, genesis: 'c'.repeat(40)}), /pins differ/)
    assert.throws(() => f.catalogue.install(owner, {...e, location: {...e.location, generation: 'new'}}), /pins differ/)
    const foreign = {...owner, genesis: 'd'.repeat(40)}
    assert.throws(() => f.catalogue.install(foreign, {...e, hubGenesis: foreign.genesis}), /another hub/)
    const reordered = Object.fromEntries(Object.entries(e).reverse()) as RoomEndpointV2
    assert.deepEqual(f.catalogue.install(owner, reordered), first)
    assert.deepEqual(f.catalogue.get(first.id), first)
  })

  it('deduplicates aliases of one physical object and refuses a retargeted alias before selection', () => {
    const f = fixture(), a = endpoint('local:///alias-a/fix'), b = {...a, address: 'local:///alias-b/fix'}
    const first = f.catalogue.install(owner, a), aliased = f.catalogue.install(owner, b)
    assert.equal(aliased.id, first.id)
    assert.deepEqual(aliased.aliases, [b.address])
    assert.equal(f.catalogue.all().length, 1)
    assert.deepEqual(f.catalogue.install(owner, b), aliased)
    f.directories.set('/alias-b/fix', a.location.directory)
    assert.equal(f.catalogue.select(parseAddress(b.address, 'lookup'), f.files).id, first.id)
    const checked = f.checks.length
    f.directories.set('/alias-b/fix', {path: '/repos/other', identity: 'other'})
    assert.throws(() => f.catalogue.select(parseAddress(b.address, 'lookup'), f.files), /changed its repository object/)
    assert.equal(f.checks.length, checked, 'a moved alias must not select the previous or new repository')
    assert.throws(() => f.catalogue.install(owner, {...b, genesis: 'd'.repeat(40)}), /pins differ/)
  })

  it('keeps copied history in different physical repositories separate', () => {
    const f = fixture(), a = endpoint('local:///copy-a/fix'), b = endpoint('local:///copy-b/fix', 'inode-2')
    const first = f.catalogue.install(owner, a), second = f.catalogue.install(owner, b)
    assert.notEqual(first.id, second.id)
    assert.equal(f.catalogue.all().length, 2)
    assert.throws(() => f.catalogue.select(parseAddress('fix', 'lookup'), f.files), /ambiguous/)
    assert.throws(() => f.catalogue.install(owner, {...a, address: 'local:///copy-c/fix', genesis: 'c'.repeat(40)}), /already pins another/)
  })

  it('does not let a pending create make a bare lookup choose another same-named room', () => {
    const f = fixture()
    f.catalogue.install(owner, endpoint('forgejo://one/space/fix'))
    f.catalogue.reserve(request(), choose)
    assert.throws(() => f.catalogue.select(parseAddress('fix', 'lookup'), f.files), /ambiguous/)
  })

  it('keeps receipt ownership and disposal in the endpoint and refuses to select disposal in progress', () => {
    const f = fixture(), e = endpoint()
    e.receipt = {reservation: 'create-1', address: e.address, genesis: e.genesis, directory: e.location.directory}
    assert.throws(() => f.catalogue.install(owner, e), /no matching create reservation/)
    f.catalogue.reserve(request(), choose)
    assert.throws(() => f.catalogue.install(owner, {...e, receipt: {...e.receipt!, genesis: 'c'.repeat(40)}}, 'create-1'), /receipt/)
    e.disposal = {phase: 'prepared', receipt: e.receipt}
    f.catalogue.install(owner, e, 'create-1')
    assert.throws(() => f.catalogue.select(parseAddress('fix', 'lookup'), f.files), /not complete/)
    assert.equal(f.records.size, 1, 'no second intent record')
  })

  it('refuses corrupt catalogue records instead of silently starting fresh', () => {
    const f = fixture(), first = f.catalogue.install(owner, endpoint()), key = [...registrationKey(first.id), 'registration'].join('/')
    f.records.set(key, {...first, address: 'local://other'})
    assert.throws(() => f.catalogue.all(), /collision/)
    f.records.set(key, {...first, owner: {...owner, trust: 'signed'}})
    assert.throws(() => f.catalogue.all(), /trust or root/)
    f.records.set(key, {...first, endpoint: {...endpoint(), store: {path: '../outside'}}})
    assert.throws(() => f.catalogue.all(), /relative/)
    f.records.set(key, {...first, endpoint: {...endpoint(), name: 'different'}})
    assert.throws(() => f.catalogue.all(), /name mismatch|identity mismatch/)
  })

  it('retains explicit key references and refuses malformed or lossy create intent before allocation', () => {
    const f = fixture(), e = {...endpoint(), keyRef: 'ringi-key:realm/provider/alice', authRef: 'ringi-key:realm/provider/alice', hostKeys: ['host ssh-ed25519 pin']}
    assert.equal(f.catalogue.install(owner, e).phase, 'active')
    assert.throws(() => f.catalogue.install(owner, {...e, keyRef: 'file:other'}), /pins differ/)
    assert.throws(() => f.catalogue.install(owner, {...e, address: 'local://other'}), /name mismatch/)
    for (const parameters of [{n: NaN}, {bad: undefined}, {bad: () => {}}, {bad: new Date()}, {bad: new Array(1)}]) {
      assert.throws(() => f.catalogue.reserve({...request(), operation: 'other', parameters: parameters as never}, () => { throw Error('must not allocate') }), /parameters|arrays/)
    }
    const cycle: Record<string, unknown> = {}; cycle.self = cycle
    assert.throws(() => f.catalogue.reserve({...request(), parameters: cycle as never}, choose), /acyclic/)
    assert.equal(f.records.size, 1)
  })

  it('refuses duplicate alias/object records and an ownerless creation receipt on disk', () => {
    const f = fixture(), a = f.catalogue.install(owner, endpoint('forgejo://one/space/fix'))
    const b = f.catalogue.install(owner, endpoint('forgejo://two/space/fix', 'inode-2'))
    const key = [...registrationKey(b.id), 'registration'].join('/')
    f.records.set(key, {...b, aliases: [a.address]})
    assert.throws(() => f.catalogue.all(), /duplicate address/)
    f.records.set(key, {...b, endpoint: {...endpoint(b.address), location: a.phase === 'active' ? a.endpoint.location : {}}})
    assert.throws(() => f.catalogue.all(), /duplicate repository object/)
    const e = endpoint(b.address, 'inode-2')
    e.receipt = {reservation: 'unknown-owner', address: e.address, genesis: e.genesis, directory: e.location.directory}
    f.records.set(key, {...b, endpoint: e})
    assert.throws(() => f.catalogue.all(), /requires its durable reservation/)
  })
})
