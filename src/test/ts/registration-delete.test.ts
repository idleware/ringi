// Real disposable filesystem transactions, including failures between durable phases. No live home or provider.
import {describe, it} from 'node:test'
import type {TestContext} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {roomFiles} from '../../main/ts/adapters/location-fs/index.ts'
import {stateFsV5} from '../../main/ts/adapters/state-fs/index.ts'
import {roomCatalogue} from '../../main/ts/core/hub/rooms/catalogue-v2.ts'
import {locationLifecycle} from '../../main/ts/core/hub/rooms/location-life.ts'
import {removeRegistration} from '../../main/ts/core/hub/rooms/registration-delete.ts'
import {registrationContext, registrationKey} from '../../main/ts/core/hub/rooms/room-registration.ts'
import type {RegistrationOwner, RoomRegistration} from '../../main/ts/core/hub/rooms/room-registration.ts'
import type {RoomEndpointV2} from '../../main/ts/core/hub/ports/store.ts'
import {parseAddress} from '../../main/ts/core/hub/rooms/address.ts'
import {contextToken} from '../../main/ts/core/hub/rooms/room-context.ts'

const owner: RegistrationOwner = {name: 'local', genesis: 'a'.repeat(40), trust: 'asserted'}
type Active = RoomRegistration & {phase: 'active'}
const active = (r: RoomRegistration): Active => { assert.equal(r.phase, 'active'); return r as Active }
const fixture = (t: TestContext, linked = false) => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ringi-delete-')))
  t.after(() => fs.rmSync(base, {recursive: true, force: true}))
  const parent = linked ? path.join(base, 'alias') : base
  if (linked) fs.symlinkSync(base, parent, 'dir')
  const home = path.join(parent, 'home'), state = stateFsV5({root: home, build: {version: 'test', resources: ''}})
  state.ensure(); state.place(['rooms']); state.place(['clones'])
  const catalogue = roomCatalogue(state), life = locationLifecycle(state, roomFiles)
  const make = (generation = 'generation-1', target = path.join(home, 'rooms', 'fix')) => {
    const reserved = catalogue.reserve({owner, operation: 'create-' + generation, parameters: {invitees: ['private-old-account']}}, () => ({address: 'local://fix', name: 'fix', generation}))
    return active(life.create(reserved.id, target, {create(p) {
      fs.writeFileSync(path.join(p.directory.path, 'history'), 'accepted history')
      return {schema: 'ringi-room/2', address: p.registration.address, name: 'fix', hubGenesis: owner.genesis, genesis: 'b'.repeat(40), trust: 'asserted', location: {directory: p.directory, generation}, store: {path: 'store'}}
    }, verify() {}}))
  }
  const remove = (r: Active, mode: 'managed' | 'unregister' = 'managed') => removeRegistration(state, roomFiles, r, {confirmed: true, mode})
  return {base, home, state, catalogue, life, make, remove}
}
const deletionKey = (r: Active) => ['room-deletions', contextToken({context: registrationContext(r)})]

describe('managed room removal and namespace archive', () => {
  it('archives through a symlinked home ancestor and recovers the same namespace after a final phase failure', t => {
    const f = fixture(t, true), r = f.make(), write = f.state.write
    f.state.write([...registrationKey(r.id), 'invitations'], {private: 'kept'})
    f.state.write = (key, value) => {
      if ((value as {phase?: string}).phase === 'archived') throw Error('fixture final phase write failed')
      write(key, value)
    }
    assert.throws(() => f.remove(r), /fixture final phase write failed/)
    f.state.write = write
    const done = f.remove(r)
    assert.equal(done.archive, fs.realpathSync(done.archive))
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(done.archive, 'invitations.json'), 'utf8')), {private: 'kept'})
    assert.equal(fs.readFileSync(path.join(done.quarantine!.path, 'history'), 'utf8'), 'accepted history')
    assert.deepEqual(f.remove(r), done)
    assert.deepEqual(f.catalogue.all(), [])
  })

  it('moves an allocated leaf and the complete namespace, preserving audit and permitting clean address reuse', t => {
    const f = fixture(t), r = f.make(), invitations = [...registrationKey(r.id), 'invitations']
    f.state.write(invitations, {old: 'private invitation'})
    f.state.write([...registrationKey(r.id), 'audit', 'nested'], {kept: true})
    const outside = path.join(f.base, 'outside'); fs.writeFileSync(outside, 'do not follow')
    fs.symlinkSync(outside, path.join(r.endpoint.location.directory.path, 'foreign-link'))
    const done = f.remove(r)
    assert.equal(fs.existsSync(r.endpoint.location.directory.path), false)
    assert.equal(fs.readFileSync(path.join(done.quarantine!.path, 'history'), 'utf8'), 'accepted history')
    assert.equal(fs.readFileSync(outside, 'utf8'), 'do not follow')
    assert.equal(fs.lstatSync(path.join(done.quarantine!.path, 'foreign-link')).isSymbolicLink(), true)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(done.archive, 'invitations.json'), 'utf8')), {old: 'private invitation'})
    assert.equal(fs.existsSync(path.join(done.archive, 'audit', 'nested.json')), true)
    assert.deepEqual(f.catalogue.all(), [])
    assert.deepEqual(f.remove(r), done, 'retry proves the archived namespace and exact quarantined object')
    const next = f.make('generation-2')
    assert.notDeepEqual(registrationContext(next), registrationContext(r))
    assert.equal(f.state.read(invitations, null), null, 'same address must not inherit old root invitations')
    assert.throws(() => f.remove(r), /incarnation changed/)
    assert.equal(fs.existsSync(next.endpoint.location.directory.path), true)
    assert.equal(f.catalogue.all().length, 1)
  })

  it('uses local allocation evidence for a joined leaf without minting a creation receipt', t => {
    const f = fixture(t), directory = roomFiles.createLeaf(path.join(f.home, 'clones', 'joined'), f.home)
    const e: RoomEndpointV2 = {schema: 'ringi-room/2', address: 'local://joined', name: 'joined', hubGenesis: owner.genesis, genesis: 'c'.repeat(40), trust: 'asserted', location: {directory, generation: 'joined-generation'}, store: {path: 'store'}}
    fs.writeFileSync(path.join(directory.path, 'history'), 'fetched history')
    const r = active(f.life.adopt(owner, e, () => {}))
    assert.equal(r.endpoint.receipt, undefined); assert.equal(r.reservation, undefined)
    const done = f.remove(r)
    assert.equal(fs.readFileSync(path.join(done.quarantine!.path, 'history'), 'utf8'), 'fetched history')
    assert.equal(f.catalogue.get(r.id), null)
  })

  it('refuses an unallocated pre-existing managed-looking leaf and external purge, but explicitly unregisters external metadata', t => {
    const f = fixture(t), external = path.join(f.base, 'external'), r = f.make('outside', external)
    assert.ok(r.endpoint.receipt, 'creation of history does not prove managed local containment')
    assert.throws(() => f.remove(r), /only an exclusively allocated managed leaf/)
    assert.equal(fs.existsSync(external), true)
    const done = f.remove(r, 'unregister')
    assert.equal(done.quarantine, undefined); assert.equal(fs.existsSync(external), true)
    assert.deepEqual(f.catalogue.all(), [])
    const target = path.join(f.home, 'rooms', 'preexisting'); fs.mkdirSync(target)
    const directory = roomFiles.canonical(target)!
    const e: RoomEndpointV2 = {...r.endpoint, address: 'local://preexisting', name: 'preexisting', location: {directory, generation: 'preexisting'}, receipt: undefined}
    const adopted = active(f.life.adopt(owner, e, () => {}))
    assert.throws(() => f.remove(adopted), /ENOENT|allocation/)
    assert.equal(f.catalogue.get(adopted.id)!.phase, 'active'); assert.equal(fs.existsSync(target), true)
  })

  it('requires exact pins and explicit confirmation before marking or moving anything', t => {
    const f = fixture(t), r = f.make()
    assert.throws(() => removeRegistration(f.state, roomFiles, r, {confirmed: false as true, mode: 'managed'}), /confirmation/)
    assert.throws(() => f.remove({...r, endpoint: {...r.endpoint, genesis: 'd'.repeat(40), receipt: {...r.endpoint.receipt!, genesis: 'd'.repeat(40)}}}), /incarnation changed/)
    assert.equal(f.catalogue.get(r.id)!.deletion, undefined)
    assert.equal(f.state.read(deletionKey(r), null), null)
    assert.equal(fs.existsSync(r.endpoint.location.directory.path), true)
  })

  it('recovers a crash after the directory rename by its exact durable destination, without repeating allocation', t => {
    const f = fixture(t), r = f.make(), write = f.state.write
    f.state.write = (key, value) => {
      if ((value as {phase?: string}).phase === 'quarantined') throw Error('fixture phase write failed')
      write(key, value)
    }
    assert.throws(() => f.remove(r), /phase write failed/)
    assert.throws(() => f.catalogue.select(parseAddress('fix', 'lookup'), roomFiles), /not complete/)
    assert.equal(fs.existsSync(r.endpoint.location.directory.path), false)
    f.state.write = write
    const done = f.remove(r)
    assert.equal(fs.readdirSync(path.join(f.home, 'trash')).length, 1)
    assert.equal(fs.readFileSync(path.join(done.quarantine!.path, 'history'), 'utf8'), 'accepted history')
    assert.deepEqual(f.catalogue.all(), [])
  })

  it('recovers a crash after namespace rename without reconstructing or clearing invitations', t => {
    const f = fixture(t), r = f.make(), write = f.state.write
    f.state.write([...registrationKey(r.id), 'invitations'], {audit: 'kept'})
    f.state.write = (key, value) => {
      if ((value as {phase?: string}).phase === 'archived') throw Error('fixture final phase write failed')
      write(key, value)
    }
    assert.throws(() => f.remove(r), /final phase write failed/)
    assert.deepEqual(f.catalogue.all(), [])
    f.state.write = write
    const done = f.remove(r)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(done.archive, 'invitations.json'), 'utf8')), {audit: 'kept'})
    assert.equal(fs.readdirSync(path.join(f.home, 'room-archives')).length, 1)
  })

  it('does not infer completed removal from a missing source or erase a replacement', t => {
    const f = fixture(t), r = f.make(), files = {...roomFiles, quarantine() {throw Error('fixture before rename')}}
    assert.throws(() => removeRegistration(f.state, files, r, {confirmed: true, mode: 'managed'}), /before rename/)
    fs.renameSync(r.endpoint.location.directory.path, path.join(f.base, 'moved-elsewhere'))
    assert.throws(() => f.remove(r), /neither a pinned source/)
    assert.equal(f.catalogue.get(r.id)!.phase, 'active')
    fs.mkdirSync(r.endpoint.location.directory.path)
    fs.writeFileSync(path.join(r.endpoint.location.directory.path, 'foreign'), 'kept')
    assert.throws(() => f.remove(r), /source changed/)
    assert.equal(fs.readFileSync(path.join(r.endpoint.location.directory.path, 'foreign'), 'utf8'), 'kept')
    assert.equal(fs.existsSync(path.join(f.home, 'room-archives')), false)
  })

  it('refuses a source that reappears after quarantine, retaining both objects and the namespace', t => {
    const f = fixture(t), r = f.make(), write = f.state.write
    f.state.write = (key, value) => {
      if ((value as {phase?: string}).phase === 'quarantined') throw Error('fixture phase write failed')
      write(key, value)
    }
    assert.throws(() => f.remove(r), /phase write failed/); f.state.write = write
    fs.mkdirSync(r.endpoint.location.directory.path)
    assert.throws(() => f.remove(r), /source changed or destination is occupied/)
    assert.equal(f.catalogue.get(r.id)!.phase, 'active')
    assert.equal(fs.readdirSync(path.join(f.home, 'trash')).length, 1)
  })

  it('refuses redirected managed parents and occupied quarantine destinations', t => {
    const f = fixture(t), r = f.make(), plan = roomFiles.planQuarantine!(r.endpoint.location.directory, f.home)
    fs.mkdirSync(plan.destination)
    assert.throws(() => roomFiles.quarantine!(plan, f.home), /destination is occupied/)
    const rooms = path.join(f.home, 'rooms'), moved = path.join(f.home, 'old-rooms')
    fs.renameSync(rooms, moved); fs.symlinkSync(moved, rooms)
    assert.throws(() => roomFiles.quarantine!(plan, f.home), /redirected|changed/)
    assert.equal(fs.existsSync(path.join(moved, 'fix', 'history')), true)
  })

  it('compares the namespace record before its single rename and refuses stale archive retries', t => {
    const f = fixture(t), r = f.make(), key = registrationKey(r.id), request = {key, record: ['registration'], value: r, token: 'archive-fixture'}
    const file = f.state.archive!(request)
    assert.equal(f.state.archive!(request), file)
    assert.deepEqual(f.catalogue.all(), [])
    fs.mkdirSync(path.join(f.home, ...key))
    f.state.write([...key, 'registration'], {...r, endpoint: {...r.endpoint, genesis: 'd'.repeat(40), receipt: {...r.endpoint.receipt!, genesis: 'd'.repeat(40)}}})
    assert.throws(() => f.state.archive!(request), /source changed|incarnation/)
    assert.equal(fs.existsSync(path.join(file, 'registration.json')), true)
    assert.equal((f.catalogue.get(r.id)! as Active).endpoint.genesis, 'd'.repeat(40))
  })

  it('refuses missing or symlinked namespace evidence and unsafe state archive keys', t => {
    const f = fixture(t), r = f.make(), request = {key: registrationKey(r.id), record: ['registration'], value: r, token: 'archive-fixture'}
    assert.throws(() => f.state.archive!({...request, key: ['..']}), /unsafe key/)
    const namespace = path.join(f.home, ...request.key), moved = path.join(f.base, 'moved-namespace')
    fs.renameSync(namespace, moved); fs.symlinkSync(moved, namespace)
    assert.throws(() => f.state.archive!(request), /redirected/)
    assert.equal(fs.existsSync(path.join(moved, 'registration.json')), true)
  })
})
