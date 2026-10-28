import {describe, it} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {TestContext} from 'node:test'
import type {LocalState} from '../../main/ts/core/hub/ports/state.ts'
import type {RoomDirectory, RoomFiles} from '../../main/ts/core/hub/ports/location.ts'
import type {RoomEndpointV2} from '../../main/ts/core/hub/ports/store.ts'
import type {RegistrationOwner, RoomRegistration} from '../../main/ts/core/hub/rooms/room-registration.ts'
import type {PreparedRoom} from '../../main/ts/core/hub/rooms/location-creation.ts'
import type {RepositoryCreation} from '../../main/ts/core/hub/rooms/location-install.ts'
import {locationLifecycle} from '../../main/ts/core/hub/rooms/location-life.ts'
import {roomCatalogue} from '../../main/ts/core/hub/rooms/catalogue-v2.ts'
import {registrationId, registrationKey} from '../../main/ts/core/hub/rooms/room-registration.ts'
import {parseAddress} from '../../main/ts/core/hub/rooms/address.ts'
import {stateFs, stateFsV5} from '../../main/ts/adapters/state-fs/index.ts'
import {roomFiles} from '../../main/ts/adapters/location-fs/index.ts'

const owner: RegistrationOwner = {name: 'local', genesis: 'a'.repeat(40), trust: 'asserted'}
const candidate = (p: PreparedRoom): RoomEndpointV2 => ({schema: 'ringi-room/2', address: p.registration.address, name: p.registration.name,
  hubGenesis: owner.genesis, genesis: 'b'.repeat(40), trust: 'asserted', location: {directory: p.directory, generation: p.registration.reservation.generation}, store: {path: 'store'}})
const active = (r: RoomRegistration): RoomRegistration & {phase: 'active'} => {
  assert.equal(r.phase, 'active')
  return r as RoomRegistration & {phase: 'active'}
}
const memory = () => {
  const data = new Map<string, unknown>(), dirs = new Map<string, RoomDirectory>(), events: string[] = []
  let serial = 0
  const key = (p: readonly string[]) => p.join('/')
  const state: LocalState = {root: '/home', ensure() {}, locked: (_name, fn) => fn(),
    read: (p, dflt) => data.has(key(p)) ? structuredClone(data.get(key(p))) as typeof dflt : dflt,
    write: (p, v) => { data.set(key(p), structuredClone(v)); events.push('write') },
    remove: () => { throw Error('metadata must be retained') },
    list: p => [...new Set([...data.keys()].filter(k => k.startsWith(key(p) + '/')).map(k => k.slice(key(p).length + 1).split('/')[0]))].sort(),
    place: () => { throw Error('no directory allocation through LocalState') },
  }
  const files: RoomFiles = {canonical: p => dirs.get(p) ?? null,
    check: d => assert.deepEqual(dirs.get(d.path), d, 'directory identity changed'),
    createLeaf: p => { if (dirs.has(p)) throw Error('existing directory retained'); const d = {path: p, identity: 'inode-' + ++serial}; dirs.set(p, d); events.push('mkdir'); return d },
    purge: receipt => { dirs.delete(receipt.directory.path); events.push('purge') },
  }
  const catalogue = roomCatalogue(state), life = locationLifecycle(state, files)
  const reserved = catalogue.reserve({owner, operation: 'create-1', parameters: {invitees: []}}, () => ({address: 'local://fix', name: 'fix', generation: 'generation-1'}))
  return {state, data, files, dirs, events, catalogue, life, reserved}
}
const temporary = (t: TestContext) => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ringi-e8-life-')))
  t.after(() => fs.rmSync(base, {force: true, recursive: true}))
  const root = path.join(base, 'home'), state = stateFsV5({root, build: {version: 'test', resources: ''}})
  state.ensure()
  return {base, root, state}
}

describe('inert location-aware room lifecycle', () => {
  it('persists preparation before repository creation, verifies before activation and retries without another create', () => {
    const f = memory(); let created = 0, verified = 0
    const repository: RepositoryCreation = {create(p) {
      created++
      const stored = f.catalogue.get(p.registration.id)!
      assert.equal(stored.reservation!.preparation!.phase, 'initializing')
      assert.deepEqual(stored.reservation!.preparation!.directory, p.directory)
      return candidate(p)
    }, verify(e) { verified++; assert.equal(f.catalogue.get(f.reserved.id)!.phase, verified === 1 ? 'reserved' : 'active'); assert.equal(e.genesis, 'b'.repeat(40)) }}
    const r = active(f.life.create(f.reserved.id, '/rooms/fix', repository))
    assert.equal(created, 1); assert.equal(verified, 1)
    assert.equal(r.endpoint.receipt!.reservation, 'create-1')
    assert.deepEqual(f.life.create(r.id, '/rooms/fix', repository), r)
    assert.equal(created, 1); assert.equal(verified, 2)
    assert.throws(() => f.life.create(r.id, '/rooms/other', repository), /does not match this create retry/)
  })

  it('retains a target after an exclusive-create refusal and refuses to change or adopt it on retry', () => {
    const f = memory(), foreign = {path: '/rooms/fix', identity: 'foreign'}
    f.dirs.set(foreign.path, foreign)
    const repository = {create: () => { throw Error('must not build') }, verify() {}}
    assert.throws(() => f.life.create(f.reserved.id, foreign.path, repository), /existing directory/)
    assert.equal(f.catalogue.get(f.reserved.id)!.reservation!.preparation!.target, foreign.path)
    assert.throws(() => f.life.create(f.reserved.id, '/rooms/other', repository), /changed its repository target/)
    assert.equal(f.catalogue.get(f.reserved.id)!.phase, 'reserved')
    assert.deepEqual(f.dirs.get(foreign.path), foreign)
  })

  it('never re-executes an interrupted create; only explicit verified recovery can activate its retained object', () => {
    const f = memory(); let creates = 0, recoveries = 0
    const failed = {create: () => { creates++; throw Error('interrupted') }, verify() {}}
    assert.throws(() => f.life.create(f.reserved.id, '/rooms/fix', failed), /interrupted/)
    assert.throws(() => f.life.create(f.reserved.id, '/rooms/fix', failed), /requires verified recovery/)
    assert.equal(creates, 1)
    const recovered = f.life.create(f.reserved.id, '/rooms/fix', {...failed, recover(p) { recoveries++; assert.equal(p.registration.reservation.operation, 'create-1'); return candidate(p) }})
    assert.equal(recovered.phase, 'active'); assert.equal(creates, 1); assert.equal(recoveries, 1)
  })

  it('keeps an unrecorded exclusive leaf after metadata write failure and refuses to silently reuse it', () => {
    const f = memory(), write = f.state.write
    f.state.write = (key, value) => {
      const r = value as RoomRegistration
      if (r.reservation?.preparation?.directory) throw Error('metadata write failed')
      write(key, value)
    }
    const repository = {create: () => { throw Error('must not create repository') }, verify() {}}
    assert.throws(() => f.life.create(f.reserved.id, '/rooms/fix', repository), /metadata write failed/)
    f.state.write = write
    assert.throws(() => f.life.create(f.reserved.id, '/rooms/fix', repository), /existing directory/)
    assert.equal(f.dirs.has('/rooms/fix'), true)
    assert.equal(f.catalogue.get(f.reserved.id)!.reservation!.preparation!.directory, undefined)
  })

  it('does not activate a malformed endpoint or one whose readback fails, and retains initialization evidence', () => {
    const f = memory(); let verifyCalls = 0
    assert.throws(() => f.life.create(f.reserved.id, '/rooms/fix', {create: p => ({...candidate(p), location: {...candidate(p).location, directory: {path: '/other', identity: 'other'}}}), verify() { verifyCalls++ }}), /changed its repository object/)
    assert.equal(verifyCalls, 0)
    assert.throws(() => f.life.create(f.reserved.id, '/rooms/fix', {create: candidate, recover: candidate, verify() { throw Error('signature readback refused') }}), /readback refused/)
    assert.equal(f.catalogue.get(f.reserved.id)!.phase, 'reserved')
    assert.equal(f.catalogue.get(f.reserved.id)!.reservation!.preparation!.phase, 'initializing')
  })

  it('detects directory replacement during verification before installing an endpoint', () => {
    const f = memory()
    assert.throws(() => f.life.create(f.reserved.id, '/rooms/fix', {create: candidate, verify() { f.dirs.set('/rooms/fix', {path: '/rooms/fix', identity: 'replacement'}) }}), /changed its directory object/)
    assert.equal(f.catalogue.get(f.reserved.id)!.phase, 'reserved')
  })

  it('verifies adoption without granting a creation receipt and deduplicates a physical alias', () => {
    const f = memory(), directory = {path: '/existing/fix', identity: 'existing'}, e: RoomEndpointV2 = {
      schema: 'ringi-room/2', address: 'local:///existing/fix', name: 'fix', hubGenesis: owner.genesis, genesis: 'c'.repeat(40), trust: 'asserted',
      location: {directory, generation: 'adopted'}, store: {path: 'store'},
    }
    f.dirs.set(directory.path, directory)
    assert.throws(() => f.life.adopt(owner, e, () => { throw Error('verification failed') }), /verification failed/)
    assert.equal(f.catalogue.all().length, 1, 'only the unrelated pending create exists')
    const first = active(f.life.adopt(owner, e, () => {}))
    assert.equal(first.endpoint.receipt, undefined)
    f.dirs.set('/alias/fix', directory)
    assert.equal(f.life.adopt(owner, {...e, address: 'local:///alias/fix'}, () => {}).id, first.id)
    assert.throws(() => f.life.dispose(first, {confirmed: true}), /no creation receipt/)
    assert.equal(f.events.includes('purge'), false)
  })

  it('keeps stored objects on distinct filesystems separate even when their inode and birth time coincide', () => {
    const f = memory(), directories = [
      {path: '/volumes/a/r', identity: '101:42:1792345410458359652'},
      {path: '/volumes/b/r', identity: '102:42:1792345410458359652'},
    ]
    const entries = directories.map(directory => {
      const endpoint: RoomEndpointV2 = {schema: 'ringi-room/2', address: 'local://' + directory.path, name: 'r',
        hubGenesis: owner.genesis, genesis: 'b'.repeat(40), trust: 'asserted', location: {directory, generation: 'adopted'}, store: {path: 'store'}}
      const r: RoomRegistration = {schema: 'ringi-registration/1', id: registrationId(endpoint.address), address: endpoint.address,
        name: endpoint.name, owner, aliases: [], phase: 'active', endpoint}
      f.dirs.set(directory.path, directory)
      f.state.write([...registrationKey(r.id), 'registration'], r)
      return r
    })
    assert.equal(f.catalogue.all().filter(r => r.phase === 'active').length, 2)
    for (const r of entries) assert.equal(f.catalogue.select(parseAddress(r.address, 'lookup'), f.files).id, r.id)
    const first = active(entries[0]), address = 'local:///volumes/c/r'
    const duplicate = {...first, id: registrationId(address), address, endpoint: {...first.endpoint, address,
      location: {...first.endpoint.location, directory: {...first.endpoint.location.directory, path: '/volumes/c/r'}}}}
    f.state.write([...registrationKey(duplicate.id), 'registration'], duplicate)
    assert.throws(() => f.catalogue.all(), /duplicate repository object registrations/)
  })

  it('requires confirmation and matching pins before any disposal mutation', () => {
    const f = memory(), r = active(f.life.create(f.reserved.id, '/rooms/fix', {create: candidate, verify() {}}))
    const before = f.events.length
    assert.throws(() => f.life.dispose(r, {confirmed: false as true}), /confirmation/)
    assert.throws(() => f.life.dispose({...r, endpoint: {...r.endpoint, genesis: 'c'.repeat(40)}}, {confirmed: true}), /endpoint moved/)
    assert.equal(f.events.length, before)
    assert.equal(f.dirs.has('/rooms/fix'), true)
  })

  it('validates opaque registration ids before constructing a lock name', () => {
    const f = memory(), r = active(f.life.create(f.reserved.id, '/rooms/fix', {create: candidate, verify() {}}))
    f.state.locked = () => { throw Error('must not attempt a lock') }
    assert.throws(() => f.life.create('../outside' as never, '/rooms/fix', {create: candidate, verify() {}}), /invalid registration id/)
    assert.throws(() => f.life.dispose({...r, id: '../outside' as never}, {confirmed: true}), /invalid registration id/)
  })

  it('persists disposal in the endpoint and retains all metadata when contained purge is unsupported', t => {
    const {base, state} = temporary(t), catalogue = roomCatalogue(state), life = locationLifecycle(state, roomFiles)
    const reserved = catalogue.reserve({owner, operation: 'own', parameters: {}}, () => ({address: 'local://fix', name: 'fix', generation: 'own-generation'}))
    const target = path.join(base, 'fix')
    const r = active(life.create(reserved.id, target, {create(p) { fs.writeFileSync(path.join(p.directory.path, 'evidence'), 'kept'); return candidate(p) }, verify() {}}))
    const inviteKey = [...registrationKey(r.id), 'invitations']
    state.write(inviteKey, {schema: 'test', audit: 'kept'})
    assert.throws(() => life.dispose(r, {confirmed: true}), /purge is unsupported/)
    assert.equal(active(catalogue.get(r.id)!).endpoint.disposal!.phase, 'prepared')
    assert.deepEqual(state.read(inviteKey, null), {schema: 'test', audit: 'kept'})
    assert.equal(fs.readFileSync(path.join(target, 'evidence'), 'utf8'), 'kept')
    assert.throws(() => catalogue.select(parseAddress('fix', 'lookup'), roomFiles), /not complete/)
  })

  it('keeps repository-removed evidence and audit metadata after a supported fixture purge; retry does not purge twice', () => {
    const f = memory(), r = active(f.life.create(f.reserved.id, '/rooms/fix', {create: candidate, verify() {}}))
    f.state.write([...registrationKey(r.id), 'invitations'], {audit: 'kept'})
    const done = active(f.life.dispose(r, {confirmed: true}))
    assert.equal(done.endpoint.disposal!.phase, 'repository-removed')
    assert.equal(f.catalogue.get(r.id)!.phase, 'active', 'metadata finalization is deliberately not implemented')
    assert.equal(f.events.filter(x => x === 'purge').length, 1)
    f.life.dispose(r, {confirmed: true})
    assert.equal(f.events.filter(x => x === 'purge').length, 1)
    f.dirs.set('/rooms/fix', {path: '/rooms/fix', identity: 'new-foreign-directory'})
    assert.throws(() => f.life.dispose(r, {confirmed: true}), /reappeared/)
    assert.equal(f.data.has([...registrationKey(r.id), 'invitations'].join('/')), true)
  })

  it('refuses to infer a completed purge when the repository disappears before the durable removed phase', () => {
    const f = memory(), r = active(f.life.create(f.reserved.id, '/rooms/fix', {create: candidate, verify() {}})), write = f.state.write
    f.state.write = (key, value) => {
      if ((value as RoomRegistration & {phase: 'active'}).endpoint?.disposal?.phase === 'repository-removed') throw Error('phase write failed')
      write(key, value)
    }
    assert.throws(() => f.life.dispose(r, {confirmed: true}), /phase write failed/)
    f.state.write = write
    assert.throws(() => f.life.dispose(r, {confirmed: true}), /disappeared/)
    assert.equal(active(f.catalogue.get(r.id)!).endpoint.disposal!.phase, 'prepared')
    assert.equal(f.events.filter(x => x === 'purge').length, 1)
  })
})

describe('separate future state home gate', () => {
  it('creates home/5 explicitly and propagates listing errors instead of treating them as an empty catalogue', t => {
    const {root, state} = temporary(t)
    assert.deepEqual(state.read(['home'], null), {version: 5})
    assert.deepEqual(state.list(['missing']), [])
    fs.writeFileSync(path.join(root, 'blocked'), 'file')
    assert.throws(() => state.list(['blocked']), (e: NodeJS.ErrnoException) => e.code === 'ENOTDIR')
    assert.throws(() => stateFs({root, build: {version: 'test', resources: ''}}).ensure(), /needs version 4/)
  })
  it('keeps the old factory on home/4 and refuses to reinterpret it as home/5', t => {
    const {base} = temporary(t), root = path.join(base, 'old'), options = {root, build: {version: 'test', resources: ''}}
    const old = stateFs(options); old.ensure()
    assert.deepEqual(old.read(['home'], null), {version: 4})
    assert.throws(() => stateFsV5(options).ensure(), /needs version 5/)
    assert.deepEqual(old.read(['home'], null), {version: 4})
  })
  it('rejects unsafe lock names before allocating a lock path in the future home', t => {
    const {root, state} = temporary(t)
    for (const name of ['../outside', '/absolute', '..', 'a\\b', 'a\0b']) assert.throws(() => state.locked(name, () => {}), /bad state key segment/)
    assert.equal(fs.existsSync(path.join(root, 'locks')), false)
  })
})
