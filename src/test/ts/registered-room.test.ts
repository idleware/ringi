// Actual git/4 repositories behind the location transaction, with isolated home/5 state and no provider service.
import {describe, it} from 'node:test'
import type {TestContext} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import childProcess from 'node:child_process'
import {createHash} from 'node:crypto'
import {syncBuiltinESMExports} from 'node:module'
import {git4Transport} from '../../main/ts/adapters/store-git/transport-v4.ts'
import {gitTransport} from '../../main/ts/adapters/store-git/transport.ts'
import {GitStore} from '../../main/ts/adapters/store-git/index.ts'
import {git} from '../../main/ts/adapters/store-git/remote/git.ts'
import {keysFile} from '../../main/ts/adapters/keys-file/index.ts'
import {roomFiles} from '../../main/ts/adapters/location-fs/index.ts'
import {stateFsV5, stateFs} from '../../main/ts/adapters/state-fs/index.ts'
import {wireHub} from '../../main/ts/core/hub/ports/index.ts'
import type {Descriptor, RoomEndpointV2} from '../../main/ts/core/hub/ports/store.ts'
import {createRegisteredRoom, adoptRegisteredRoom, openRegisteredRoom, roomContextKey, registeredRoomLock, registeredControlChange,
  controlChange, deleteRoom, isRegisteredRoom, append} from '../../main/ts/core/hub/rooms/index.ts'
import {deleteRegisteredRoom, deleteRoomRegistration, registeredMetadataChange, provisionedRepository} from '../../main/ts/core/hub/rooms/index.ts'
import {registeredTransportOf, legacyTransportOf, transportOf} from '../../main/ts/core/hub/rooms/index.ts'
import type {Hub, Room} from '../../main/ts/core/hub/rooms/index.ts'
import {genesisFiles} from '../../main/ts/core/hub/rooms/contracts.ts'
import {roomCatalogue} from '../../main/ts/core/hub/rooms/catalogue-v2.ts'
import {registrationContext} from '../../main/ts/core/hub/rooms/room-registration.ts'
import {locationLifecycle} from '../../main/ts/core/hub/rooms/location-life.ts'
import {roomRepositoryV4, repositoryIntent} from '../../main/ts/core/hub/rooms/repository-v2.ts'
import {canonical, parseAddress} from '../../main/ts/core/hub/rooms/address.ts'
import {reservationParameters} from '../../main/ts/core/hub/rooms/reservation.ts'

const fixture = (t: TestContext, signed = false, requiredCapability = true, address = 'local://r') => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ringi-registered-')))
  t.after(() => fs.rmSync(base, {recursive: true, force: true}))
  const home = path.join(base, 'home'), build = {version: 'fixture', resources: fileURLToPath(new URL('../../main/resources', import.meta.url))}
  const state = stateFsV5({root: home, build}); state.ensure()
  let signerCalls = 0
  const transport = git4Transport(home, {signer: () => {signerCalls++; assert.ok(signed, 'asserted transport must not construct a Signer'); return keysFile(home)}})
  // Deliberately retain the old registry factory; explicit V4 opening must not consult that layout or change it.
  const legacy = gitTransport(home)
  wireHub({state, build, transports: {git: legacy}, store: 'git', roomFiles})
  const d: Descriptor = {schema: 'ringi-hub/3', name: 'fixture', genesis: '', trust: signed ? 'signed' : 'asserted', store: {type: 'git'}, contract: {path: 'contract'}}
  const H: Hub = {name: d.name, dir: path.join(home, 'operator-source'), d, signed}
  const made = transport.create(H.dir, d, x => {
    const files = genesisFiles(x, 'git/4')
    if (!requiredCapability) {const c = JSON.parse(files['contract.json']); c.capabilities = []; files['contract.json'] = JSON.stringify(c)}
    return {files, text: 'hub fixture\n\nTo: *\nKind: hub\n'}
  })
  const source = made.store as GitStore
  const spec = {contract: source.contractHead(), files: {
    'members.json': JSON.stringify({members: {operator: {role: 'root'}, ...(signed ? {} : {alice: {}})}, retired: {}}),
    'profile.json': fs.readFileSync(path.join(build.resources, 'profiles/a2a-1.json'), 'utf8'), 'ROOM.md': '# fixture room\n',
    ...(signed ? {allowed_signers: source.rootRoster()} : {}),
  }, description: 'fixture description', quorum: 1}
  const catalogue = roomCatalogue(state), target = path.join(base, 'room')
  const reserved = catalogue.reserve({owner: d, operation: 'create-1', parameters: {repository: repositoryIntent(spec), invitees: ['private-account-not-published']}},
    () => ({address, name: 'r', generation: 'generation-1'}))
  return {base, home, H, spec, source, state, build, transport, legacy, catalogue, reserved, target, signerCalls: () => signerCalls}
}
const pathAddress = (p: string) => canonical(parseAddress('local://' + p, 'lookup') as {kind: 'path', path: string})

describe('git/4 registered room integration', () => {
  it('refuses endpoint/2 adoption under another name while retaining the original history and registration', t => {
    for (const signed of [false, true]) {
      const f = fixture(t, signed), R = createRegisteredRoom(f.H, f.reserved.id, f.target, f.transport, f.spec)
      const endpoint: RoomEndpointV2 = {...R.endpoint, address: 'local://foreign', name: 'foreign', receipt: undefined}
      assert.throws(() => adoptRegisteredRoom(f.H, endpoint, f.transport), /room genesis subject must be "room foreign"/)
      assert.equal(openRegisteredRoom(f.H, 'r', f.transport).genesis, R.genesis)
      assert.equal(f.catalogue.all().length, 1)
      assert.equal(fs.existsSync(f.target), true)
    }
  })

  it('resolves reserved SSH options only after the provider result while retaining the signing identity and original intent', t => {
    const f = fixture(t, true), requested = {...f.spec, reach: {keyRef: 'selected-root', authRef: 'selected-root', hostKeys: ['fixture.invalid public-pinned-key']}}
    const original = structuredClone(requested), address = 'forgejo://fixture.invalid/team/provisioned'
    const reserved = f.catalogue.reserve({owner: f.H.d, operation: 'provision-identity', parameters: {repository: repositoryIntent(requested), invitees: []}},
      () => ({address, name: 'provisioned', generation: 'provisioned-generation'}))
    const origin = path.join(f.base, 'provisioned.git'); git(f.source.h, ['init', '-q', '--bare', '-b', 'main', origin])
    const remote = 'git+' + pathToFileURL(origin).href
    const bound = f.catalogue.bindRemote(reserved.id, remote), spec = provisionedRepository(requested, remote)
    assert.equal(spec.reach!.keyRef, 'selected-root'); assert.equal(spec.reach!.authRef, undefined); assert.equal(spec.reach!.hostKeys, undefined)
    assert.deepEqual(requested, original); assert.equal(bound.reservation!.parameters, reserved.reservation!.parameters)
    const transport = git4Transport(f.home, {signer: () => keysFile(f.home), auth: {resolve() {assert.fail('file locator must not resolve SSH credentials')}}})
    const R = createRegisteredRoom(f.H, reserved.id, f.target, transport, spec)
    assert.equal(R.endpoint.keyRef, 'selected-root'); assert.equal(R.endpoint.authRef, undefined); assert.equal(R.endpoint.hostKeys, undefined)
    const misconfigured = transport.open(f.target, f.H.d, {...R.endpoint, authRef: 'selected-root'})
    assert.throws(() => misconfigured.sync(), /supported only for SSH/)
    const ssh = provisionedRepository(requested, 'git+ssh://git@fixture.invalid/team/provisioned.git')
    assert.equal(ssh.reach!.authRef, 'selected-root'); assert.deepEqual(ssh.reach!.hostKeys, requested.reach.hostKeys)
    assert.notEqual(ssh.reach!.hostKeys, requested.reach.hostKeys)
    const https = provisionedRepository(requested, 'git+https://fixture.invalid/team/provisioned.git')
    assert.equal(https.reach!.keyRef, 'selected-root'); assert.equal(https.reach!.authRef, undefined); assert.equal(https.reach!.hostKeys, undefined)
    assert.throws(() => provisionedRepository(requested, 'git+https://user:secret@fixture.invalid/r'), /credentials/)
    assert.throws(() => provisionedRepository(spec, remote), /unresolved requested locator/)
  })

  it('quarantines a real managed Git repository and archives its invitations, refusing stale metadata after address reuse', t => {
    const f = fixture(t, true), target = path.join(f.state.place(['rooms']), 'r')
    const R = createRegisteredRoom(f.H, f.reserved.id, target, f.transport, f.spec)
    registeredMetadataChange(R, () => f.state.write(['catalogue', 'rooms', R.id, 'invitations'], {private: 'old actor'}))
    const result = deleteRegisteredRoom(R, {confirmed: true, mode: 'managed'})
    assert.equal(fs.existsSync(path.join(result.quarantine!.path, 'store', '.git')), true)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(result.archive, 'invitations.json'), 'utf8')), {private: 'old actor'})
    assert.throws(() => openRegisteredRoom(f.H, 'r', f.transport), /unknown room/)
    const reserved = f.catalogue.reserve({owner: f.H.d, operation: 'create-2', parameters: {repository: repositoryIntent(f.spec), invitees: []}},
      () => ({address: R.endpoint.address, name: 'r', generation: 'generation-2'}))
    const next = createRegisteredRoom(f.H, reserved.id, target, f.transport, f.spec)
    let writes = 0
    assert.throws(() => registeredMetadataChange(R, () => {writes++}), /incarnation changed/)
    registeredMetadataChange(next, () => {writes++})
    assert.equal(writes, 1)
    assert.equal(f.state.read(['catalogue', 'rooms', next.id, 'invitations'], null), null)
  })
  it('blocks metadata writers during disposal and resumes via the retained registration without opening its repository', t => {
    const f = fixture(t), R = createRegisteredRoom(f.H, f.reserved.id, f.target, f.transport, f.spec)
    const archive = f.state.archive!
    f.state.archive = () => {throw Error('fixture archive unavailable')}
    assert.throws(() => deleteRegisteredRoom(R, {confirmed: true, mode: 'unregister'}), /archive unavailable/)
    let called = false
    assert.throws(() => registeredMetadataChange(R, () => {called = true}), /disposal is in progress/)
    assert.equal(called, false)
    assert.throws(() => openRegisteredRoom(f.H, 'r', f.transport), /not complete/)
    f.state.archive = archive
    const retained = f.catalogue.get(R.id)!
    assert.equal(retained.phase, 'active')
    if (retained.phase !== 'active') assert.fail('retained registration required')
    const done = deleteRoomRegistration(retained, {confirmed: true, mode: 'unregister'})
    assert.equal(done.quarantine, undefined); assert.equal(fs.existsSync(f.target), true)
    assert.deepEqual(f.catalogue.all(), [])
  })

  it('isolates cached stores by the explicitly injected transport and signing context', t => {
    const f = fixture(t, true), R = createRegisteredRoom(f.H, f.reserved.id, f.target, f.transport, f.spec)
    assert.throws(() => openRegisteredRoom(f.H, 'r', git4Transport(f.home)), /Signer/)
    const other = git4Transport(f.home, {signer: () => keysFile(f.home)})
    const reopened = openRegisteredRoom(f.H, 'r', other)
    assert.notEqual(reopened.store, R.store, 'another injected transport must not inherit a cached signing context')
    assert.equal(openRegisteredRoom(f.H, 'r', other).store, reopened.store)
    assert.equal(openRegisteredRoom(f.H, 'r', f.transport).store, R.store)
  })
  it('binds the provider locator once after reservation and recovers its exact committed intent', t => {
    const f = fixture(t, true, true, 'forgejo://fixture.invalid/team/r'), parameters = JSON.parse(f.reserved.reservation!.parameters)
    const origin = path.join(f.base, 'origin.git'); git(f.source.h, ['init', '-q', '--bare', '-b', 'main', origin])
    const remote = 'git+' + pathToFileURL(origin).href
    for (const bad of ['git+https://user:secret@fixture.invalid/r', 'git+https://fixture.invalid/r?token=secret', 'git+file:///tmp/r#fragment']) {
      assert.throws(() => f.catalogue.bindRemote(f.reserved.id, bad), /credentials, query or fragment/)
    }
    const bound = f.catalogue.bindRemote(f.reserved.id, remote)
    assert.equal(bound.reservation!.parameters, f.reserved.reservation!.parameters)
    assert.equal(bound.reservation!.provision!.remote, remote)
    const retry = f.catalogue.reserve({owner: f.H.d, operation: 'create-1', parameters}, () => {throw Error('must not redraw a target')})
    assert.deepEqual(retry, bound)
    assert.throws(() => f.catalogue.bindRemote(bound.id, remote + '-changed'), /provider result changed/)
    assert.throws(() => createRegisteredRoom(f.H, bound.id, f.target, f.transport, f.spec), /differs from the durable/)
    assert.equal(fs.existsSync(f.target), false)
    const spec = {...f.spec, reach: {remote}}, repository = roomRepositoryV4(f.H, f.transport, f.source, spec), life = locationLifecycle(f.state, roomFiles)
    assert.throws(() => life.create(bound.id, f.target, {...repository, create(p) {repository.create(p); throw Error('fixture crash after provisioned genesis')}}), /fixture crash/)
    life.create(bound.id, f.target, {...repository, create() {assert.fail('must recover')}})
    const R = openRegisteredRoom(f.H, bound.address, f.transport)
    const commitment = createHash('sha256').update(reservationParameters({parameters, provision: {remote}})).digest('hex')
    assert.ok(R.s.control[0].text.includes('Creation-Intent: ' + commitment))
    assert.equal(R.endpoint.store.remote, remote); assert.equal(R.s.control.length, 1)
    assert.deepEqual(f.catalogue.bindRemote(bound.id, remote).reservation!.provision, {remote})
    assert.equal(R.s.control[0].text.includes('private-account-not-published'), false)
  })
  it('retries only its own empty denied attachment with unchanged endpoint and identity', t => {
    const f = fixture(t, true), R = createRegisteredRoom(f.H, f.reserved.id, f.target, f.transport, f.spec), store = R.store as GitStore
    const origin = path.join(f.base, 'origin.git'); git(store.h, ['init', '-q', '--bare', '-b', 'main', origin]); git(store.h, ['push', '-q', origin, 'refs/heads/main', 'refs/heads/chat'])
    const replica = path.join(f.base, 'denied-replica'), directory = roomFiles.createLeaf(replica, f.home), {receipt, ...unowned} = R.endpoint
    const e = {...unowned, address: pathAddress(replica), location: {directory, generation: 'denied-1'}, store: {path: 'store', remote: 'git+' + pathToFileURL(origin).href}}
    const sync = GitStore.prototype.sync
    GitStore.prototype.sync = () => {throw Object.assign(new Error('fixture explicit repository denial'), {code: 'denied'})}
    try {assert.throws(() => f.transport.attachRoom(replica, f.H.d, e), {code: 'denied'})} finally {GitStore.prototype.sync = sync}
    assert.deepEqual(roomFiles.canonical(replica), directory)
    assert.equal(JSON.parse(fs.readFileSync(path.join(replica, 'ringi-attachment.json'), 'utf8')).phase, 'denied')
    assert.throws(() => f.transport.attachRoom(replica, f.H.d, {...e, keyRef: 'different-selected-key'}), /witness changed/)
    const joined = f.transport.attachRoom(replica, f.H.d, e)
    assert.equal(joined.room('r')!.genesis, R.genesis)
    assert.equal(f.catalogue.all().length, 1, 'retrying fetch still does not register or bind an agent')
    assert.equal(JSON.parse(fs.readFileSync(path.join(replica, 'ringi-attachment.json'), 'utf8')).phase, 'complete')
    assert.equal(f.transport.attachRoom(replica, f.H.d, e).room('r')!.genesis, R.genesis)
    assert.equal(adoptRegisteredRoom(f.H, e, f.transport).endpoint.receipt, undefined)
  })
  it('retains non-denied or nonempty failed attachments and refuses their automatic retry', t => {
    for (const partial of [false, true]) {
      const f = fixture(t, true), R = createRegisteredRoom(f.H, f.reserved.id, f.target, f.transport, f.spec), {receipt, ...unowned} = R.endpoint
      const replica = path.join(f.base, 'partial-replica'), directory = roomFiles.createLeaf(replica, f.home)
      const e = {...unowned, address: pathAddress(replica), location: {directory, generation: 'partial-1'}, store: {path: 'store', remote: 'git+file:///private/tmp/never-contacted'}}
      const sync = GitStore.prototype.sync
      GitStore.prototype.sync = function () {
        if (partial) git(this.h, ['hash-object', '-w', '--stdin'], {input: 'fixture fetched object'})
        throw Object.assign(new Error('fixture interrupted fetch'), {code: partial ? 'denied' : 'ETIMEDOUT'})
      }
      try {assert.throws(() => f.transport.attachRoom(replica, f.H.d, e), /fixture interrupted fetch/)} finally {GitStore.prototype.sync = sync}
      assert.throws(() => f.transport.attachRoom(replica, f.H.d, e), /unverified partial initialization/)
      assert.deepEqual(roomFiles.canonical(replica), directory)
      assert.equal(f.catalogue.all().length, 1)
    }
  })
  it('narrows an explicit transport registry before accepting either endpoint layout', t => {
    const f = fixture(t), R = createRegisteredRoom(f.H, f.reserved.id, f.target, f.transport, f.spec)
    assert.equal(legacyTransportOf(f.H.name, 'git'), f.legacy)
    assert.throws(() => registeredTransportOf(f.H.name, 'git'), /explicit git\/4/)
    wireHub({state: f.state, build: f.build, transports: {git: f.transport}, store: 'git', roomFiles})
    assert.equal(transportOf(f.H.name, 'git'), f.transport)
    assert.equal(registeredTransportOf(f.H.name, 'git'), f.transport)
    assert.throws(() => legacyTransportOf(f.H.name, 'git'), /endpoint\/1 operations/)
    const head = R.store.room(R.name)!.head
    assert.throws(() => controlChange(R, 'operator', 'join bob', m => {m.bob = {}}), /endpoint\/2 control/)
    assert.equal(R.store.room(R.name)!.head, head)
  })
  it('narrows the common Room view and refuses legacy mutation or purge before touching old state', t => {
    const f = fixture(t), R: Room = createRegisteredRoom(f.H, f.reserved.id, f.target, f.transport, f.spec)
    assert.ok(isRegisteredRoom(R)); assert.equal(R.id, f.reserved.id)
    const legacy = ['hub', f.H.name, 'rooms', R.name, 'endpoint'], reader = ['readers', f.H.d.genesis, R.genesis, 'alice']
    f.state.write(legacy, {legacy: 'keep'}); f.state.write(reader, {legacy: 'reader'})
    const before = R.store.room(R.name)!.head, lock = f.state.locked
    let locks = 0
    f.state.locked = (name, fn) => {locks++; return lock(name, fn)}
    assert.throws(() => controlChange(R, 'operator', 'join bob', m => {m.bob = {}}), /endpoint\/2 control/)
    assert.throws(() => deleteRoom(R), /receipt-bound location lifecycle/)
    assert.equal(locks, 0, 'a legacy refusal must precede every legacy state lock and mutation')
    assert.equal(R.store.room(R.name)!.head, before)
    assert.deepEqual(f.state.read(legacy, null), {legacy: 'keep'})
    assert.deepEqual(f.state.read(reader, null), {legacy: 'reader'})
    assert.equal(f.catalogue.get(R.id)!.phase, 'active')
  })
  it('writes asserted member controls through the registered context and preserves terminal actors', t => {
    const f = fixture(t), first = createRegisteredRoom(f.H, f.reserved.id, f.target, f.transport, f.spec)
    first.store.remove!(first.s, 'operator', 'alice')
    const retired = openRegisteredRoom(f.H, 'r', f.transport)
    // A join caller may already hold the room's seat lock; the control operation must not reacquire it.
    const joined = f.state.locked(registeredRoomLock(retired), () => registeredControlChange(retired, f.transport,
      {who: 'operator', subject: 'join alice-2', mutate: m => {m['alice-2'] = {role: 'member'}}}))
    assert.equal(joined.id, first.id); assert.equal(joined.members['alice-2'].role, 'member')
    assert.equal(Object.hasOwn(joined.members, 'alice'), false)
    assert.equal(joined.store.retirements(joined.s).alice, retired.head)
    assert.equal(fs.existsSync(path.join(f.home, 'hub', f.H.name, 'rooms')), false)
    assert.ok(append(joined, 'alice-2', 'hello\n\nTo: *\n'))
    const before = joined.store.room(joined.name)!.head
    assert.throws(() => registeredControlChange(joined, f.transport, {who: 'operator', subject: 'join alice', mutate: m => {m.alice = {}}}), /retired/)
    assert.equal(joined.store.room(joined.name)!.head, before)
  })
  it('refuses non-root and signed membership mutations without advancing the accepted control', t => {
    for (const signed of [false, true]) {
      const f = fixture(t, signed), R = createRegisteredRoom(f.H, f.reserved.id, f.target, f.transport, f.spec), head = R.head
      assert.throws(() => registeredControlChange(R, f.transport, {who: signed ? 'operator' : 'alice', subject: 'join bob', mutate: m => {m.bob = {}}}),
        signed ? /explicit key admission/ : /operator|root|control/)
      assert.equal(R.store.room(R.name)!.head, head)
      assert.equal(Object.hasOwn(openRegisteredRoom(f.H, 'r', f.transport).members, 'bob'), false)
    }
  })
  it('refuses a stale registered view before its mutation callback, preserving the selected identity', t => {
    const f = fixture(t), R = createRegisteredRoom(f.H, f.reserved.id, f.target, f.transport, f.spec)
    const wrong = {...R, context: [...R.context.slice(0, 4), 'another-generation']}
    let calls = 0
    assert.throws(() => registeredControlChange(wrong, f.transport, {who: 'operator', subject: 'join bob', mutate: () => {calls++}}), /identity changed/)
    assert.equal(calls, 0); assert.equal(R.store.room(R.name)!.head, R.head)
  })
  for (const signed of [false, true]) it(`creates and reopens a verified endpoint/2 with its actual catalogue identity (${signed ? 'signed' : 'asserted'})`, t => {
    const f = fixture(t, signed), R = createRegisteredRoom(f.H, f.reserved.id, f.target, f.transport, f.spec)
    assert.equal(R.endpoint.schema, 'ringi-room/2'); assert.equal(R.id, f.reserved.id)
    assert.ok(R.contract.capabilities?.includes('rooms/1')); assert.equal(f.legacy.layout, 'git/3')
    assert.deepEqual(R.context, registrationContext(f.catalogue.get(R.id)!))
    assert.equal(R.endpoint.location.directory.path, fs.realpathSync(f.target))
    assert.equal(R.endpoint.receipt?.reservation, 'create-1'); assert.equal(R.profile.name, 'a2a-1')
    assert.equal(R.membersAt!(R.genesis).operator.role, 'root')
    assert.throws(() => R.membersAt!('f'.repeat(40)), /accepted control/)
    assert.equal(R.s.control[0].text.includes('private-account-not-published'), false)
    const again = createRegisteredRoom(f.H, f.reserved.id, f.target, f.transport, f.spec)
    assert.equal(again.genesis, R.genesis); assert.equal(again.s.tip, R.s.tip)
    assert.equal(openRegisteredRoom(f.H, 'r', f.transport).store, again.store, 'same selected context reuses its store')
    if (!signed) assert.equal(f.signerCalls(), 0)
  })
  it('recovers exactly one completed genesis after interrupted activation, without rerunning creation or disclosing the intent', t => {
    const f = fixture(t, true), repository = roomRepositoryV4(f.H, f.transport, f.source, f.spec), life = locationLifecycle(f.state, roomFiles)
    let creates = 0
    assert.throws(() => life.create(f.reserved.id, f.target, {...repository, create(p) {creates++; repository.create(p); throw Error('fixture crash after genesis')}}), /fixture crash/)
    assert.equal(f.catalogue.get(f.reserved.id)!.phase, 'reserved')
    const recovered = life.create(f.reserved.id, f.target, {...repository, create() {assert.fail('must recover rather than create')}})
    assert.equal(creates, 1); assert.equal(recovered.phase, 'active')
    const R = openRegisteredRoom(f.H, 'r', f.transport)
    assert.equal(R.s.control.length, 1)
    assert.equal(R.s.control[0].text.includes('private-account-not-published'), false)
    assert.match(R.s.control[0].text, /Creation-Intent: [0-9a-f]{64}/)
    assert.equal(R.endpoint.receipt?.reservation, 'create-1')
  })
  it('refuses changed builder intent and missing required capability before repository allocation', t => {
    const f = fixture(t)
    assert.throws(() => createRegisteredRoom(f.H, f.reserved.id, f.target, f.transport, {...f.spec, description: 'changed'}), /differs from the durable/)
    assert.equal(fs.existsSync(path.join(f.target, 'store')), false)
    const g = fixture(t, false, false)
    assert.throws(() => createRegisteredRoom(g.H, g.reserved.id, g.target, g.transport, g.spec), /does not require rooms\/1/)
    assert.equal(fs.existsSync(g.target), false)
    assert.equal(g.catalogue.get(g.reserved.id)!.phase, 'reserved')
  })
  it('preserves foreign paths and refuses incomplete initialization rather than recreating it', t => {
    const f = fixture(t)
    fs.mkdirSync(f.target); fs.writeFileSync(path.join(f.target, 'foreign'), 'keep')
    assert.throws(() => createRegisteredRoom(f.H, f.reserved.id, f.target, f.transport, f.spec), /EEXIST/)
    assert.equal(fs.readFileSync(path.join(f.target, 'foreign'), 'utf8'), 'keep')
    const g = fixture(t), repository = roomRepositoryV4(g.H, g.transport, g.source, g.spec), life = locationLifecycle(g.state, roomFiles)
    assert.throws(() => life.create(g.reserved.id, g.target, {...repository, create(p) {
      const e: RoomEndpointV2 = {schema: 'ringi-room/2', address: p.registration.address, name: p.registration.name, hubGenesis: g.H.d.genesis, genesis: '', trust: 'asserted',
        location: {directory: p.directory, generation: p.registration.reservation.generation}, store: {path: 'store'}}
      g.transport.fork(g.target, g.H.d, g.source, e); throw Error('fixture crash before room genesis')
    }}), /fixture crash/)
    assert.throws(() => life.create(g.reserved.id, g.target, repository), /no completed room genesis/)
    assert.equal(g.catalogue.get(g.reserved.id)!.phase, 'reserved')
    assert.equal(fs.existsSync(path.join(g.target, 'store/.git')), true)
  })
  it('deduplicates physical aliases, rejects alias retargeting before cache reuse and separates copied histories', t => {
    const f = fixture(t), A = createRegisteredRoom(f.H, f.reserved.id, f.target, f.transport, f.spec)
    const alias = path.join(f.base, 'alias'); fs.symlinkSync(f.target, alias, 'dir')
    const {receipt, ...joined} = A.endpoint
    const aliased = adoptRegisteredRoom(f.H, {...joined, address: pathAddress(alias)}, f.transport)
    assert.equal(aliased.id, A.id); assert.equal(aliased.context[1], 'local://r')
    assert.equal(openRegisteredRoom(f.H, pathAddress(alias), f.transport).store, aliased.store)
    const copy = path.join(f.base, 'copy'); fs.cpSync(f.target, copy, {recursive: true})
    const B = adoptRegisteredRoom(f.H, {...joined, address: pathAddress(copy), location: {directory: roomFiles.canonical(copy)!, generation: 'generation-copy'}}, f.transport)
    assert.equal(B.genesis, A.genesis); assert.notEqual(B.id, A.id)
    assert.notDeepEqual(roomContextKey(A, 'readers', 'alice'), roomContextKey(B, 'readers', 'alice'))
    assert.notEqual(registeredRoomLock(A), registeredRoomLock(B)); assert.notEqual(A.store, B.store)
    f.state.write(roomContextKey(A, 'readers', 'alice'), {value: 'A'}); f.state.write(roomContextKey(B, 'readers', 'alice'), {value: 'B'})
    assert.deepEqual(f.state.read(roomContextKey(A, 'readers', 'alice'), null), {value: 'A'})
    assert.throws(() => openRegisteredRoom(f.H, 'r', f.transport), /ambiguous/)
    fs.unlinkSync(alias); fs.symlinkSync(copy, alias, 'dir')
    assert.throws(() => openRegisteredRoom(f.H, pathAddress(alias), f.transport), /changed its repository object/)
  })
  it('requires explicit home/5 rather than writing a new catalogue into a legacy home', t => {
    const f = fixture(t), root = path.join(f.base, 'old-home'), legacyState = stateFs({root, build: f.build}); legacyState.ensure()
    wireHub({state: legacyState, build: f.build, transports: {git: f.legacy}, store: 'git', roomFiles})
    assert.throws(() => createRegisteredRoom(f.H, f.reserved.id, f.target, f.transport, f.spec), /explicit home\/5/)
    assert.equal(fs.existsSync(path.join(root, 'catalogue')), false); assert.equal(fs.existsSync(f.target), false)
  })
  it('attaches into an explicitly witnessed empty replica and verifies a local file origin before adoption', t => {
    const f = fixture(t, true), R = createRegisteredRoom(f.H, f.reserved.id, f.target, f.transport, f.spec), s = R.store as GitStore
    const origin = path.join(f.base, 'origin.git'); git(s.h, ['init', '-q', '--bare', '-b', 'main', origin]); git(s.h, ['push', '-q', origin, 'refs/heads/main', 'refs/heads/chat'])
    const replica = path.join(f.base, 'replica'), directory = roomFiles.createLeaf(replica, f.home), {receipt, ...joined} = R.endpoint
    const e = {...joined, address: pathAddress(replica), location: {directory, generation: 'replica-1'}, store: {path: 'store', remote: 'git+' + pathToFileURL(origin).href}}
    const store = f.transport.attachRoom(replica, f.H.d, e)
    assert.equal(store.room('r')!.genesis, R.genesis)
    assert.equal(f.catalogue.all().length, 1, 'successful fetch alone installs no active catalogue registration or agent seat')
    const adopted = adoptRegisteredRoom(f.H, e, f.transport)
    assert.equal(adopted.endpoint.receipt, undefined); assert.notEqual(adopted.id, R.id)
    assert.equal(adopted.genesis, R.genesis)
  })
  it('refuses HEAD repair and resolves an explicit actor identity before any repository exists', t => {
    const f = fixture(t, true), R = createRegisteredRoom(f.H, f.reserved.id, f.target, f.transport, f.spec)
    const {receipt, ...unowned} = R.endpoint
    const missing = path.join(f.base, 'not-fetched'), e = {...unowned, location: {directory: {path: missing, identity: 'future'}, generation: 'future-1'}, keyRef: 'ringi-key:room/' + 'a'.repeat(64) + '/alice'}
    const identity = f.transport.identity!(f.H.d, 'alice', e)
    assert.match(identity.publicKey, /^ssh-/); assert.equal(fs.existsSync(missing), false)
    assert.equal(Object.hasOwn(R.members, 'alice'), false)
    const head = path.join(f.target, 'store/.git/HEAD'), detached = R.genesis + '\n'; fs.writeFileSync(head, detached)
    assert.throws(() => f.transport.open(f.target, f.H.d, R.endpoint), /HEAD must name/)
    assert.equal(fs.readFileSync(head, 'utf8'), detached)
  })
  it('retains a failed witnessed attachment without installing metadata or recursively deleting evidence', t => {
    const f = fixture(t, true), R = createRegisteredRoom(f.H, f.reserved.id, f.target, f.transport, f.spec), s = R.store as GitStore
    const origin = path.join(f.base, 'origin.git'); git(s.h, ['init', '-q', '--bare', '-b', 'main', origin]); git(s.h, ['push', '-q', origin, 'refs/heads/main', 'refs/heads/chat'])
    const replica = path.join(f.base, 'failed-replica'), directory = roomFiles.createLeaf(replica, f.home), {receipt, ...unowned} = R.endpoint
    const e = {...unowned, genesis: 'f'.repeat(40), address: pathAddress(replica), location: {directory, generation: 'failed-1'}, store: {path: 'store', remote: 'git+' + pathToFileURL(origin).href}}
    assert.throws(() => f.transport.attachRoom(replica, f.H.d, e), /malformed commit|changed|ALARM/)
    assert.equal(fs.existsSync(path.join(replica, 'store/.git')), true)
    assert.equal(f.catalogue.all().length, 1)
    assert.deepEqual(roomFiles.canonical(replica), directory)
  })
  it('refuses redirected Git children even when the outer directory and room history are unchanged', t => {
    for (const child of ['store', 'store/.git', 'store/.git/objects']) {
      const f = fixture(t), R = createRegisteredRoom(f.H, f.reserved.id, f.target, f.transport, f.spec)
      const from = path.join(f.target, child), elsewhere = path.join(f.base, 'elsewhere')
      fs.renameSync(from, elsewhere); fs.symlinkSync(elsewhere, from, 'dir')
      const before = fs.readdirSync(elsewhere).sort()
      assert.throws(() => f.transport.open(f.target, f.H.d, R.endpoint), /real directories/)
      let syncs = 0; R.store.sync = () => {syncs++}
      assert.throws(() => openRegisteredRoom(f.H, 'local://r', f.transport), /real directories/)
      assert.equal(syncs, 0, 'cached handles must not synchronize through redirected children')
      assert.deepEqual(fs.readdirSync(elsewhere).sort(), before)
      assert.deepEqual(roomFiles.canonical(f.target), R.endpoint.location.directory)
    }
  })
  for (const operation of ['admit', 'remove']) it(`retries the exact retained ${operation} control after a publication refusal`, t => {
    const f = fixture(t, true), R = createRegisteredRoom(f.H, f.reserved.id, f.target, f.transport, f.spec), store = R.store as GitStore
    const key = f.transport.identity!(f.H.d, 'alice', {...R.endpoint, keyRef: 'ringi-key:room/' + 'b'.repeat(64) + '/alice'}).publicKey
    if (operation === 'remove') store.admit(R.s, 'alice', key)
    const origin = path.join(f.base, 'origin.git'); git(store.h, ['init', '-q', '--bare', '-b', 'main', origin]); git(store.h, ['push', '-q', origin, 'refs/heads/main', 'refs/heads/chat'])
    store.h.endpoint!.store.remote = 'git+' + pathToFileURL(origin).href; store.sync()
    const before = store.rev('refs/heads/chat')!, original = childProcess.spawnSync
    let rejected = false
    childProcess.spawnSync = ((command: string, args: string[], options: never) => {
      if (!rejected && command === 'git' && args.includes('push')) {
        rejected = true
        return {pid: 0, output: [null, '', 'fixture publication refusal'], stdout: '', stderr: 'fixture publication refusal', status: 1, signal: null}
      }
      return original(command, args, options)
    }) as typeof original
    syncBuiltinESMExports()
    const act = () => operation === 'admit' ? store.admit(store.room('r')!, 'alice', key) : store.remove(store.room('r')!, 'operator', 'alice')
    try {assert.throws(act, /ALARM.*push rejected/)} finally {childProcess.spawnSync = original; syncBuiltinESMExports()}
    assert.equal(rejected, true)
    const retained = store.rev('refs/heads/chat')!
    assert.notEqual(retained, before)
    assert.equal(git(store.h, ['ls-remote', origin, 'refs/heads/chat']).trim().split(/\s/)[0], before)
    assert.equal(act(), retained)
    assert.equal(store.rev('refs/heads/chat'), retained, 'retry must not append another control')
    assert.equal(git(store.h, ['ls-remote', origin, 'refs/heads/chat']).trim().split(/\s/)[0], retained)
    assert.equal(store.rev('refs/ringi/remote-accepted/chat'), retained)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(store.dir, 'ringi/push-alarms.json'), 'utf8')), {})
  })
})
