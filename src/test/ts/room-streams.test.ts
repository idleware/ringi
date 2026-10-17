// Repo-per-room routing, contract fan-out and stream evidence exercised on real disposable Git repositories.
import {it} from 'node:test'
import type {TestContext} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import childProcess from 'node:child_process'
import {syncBuiltinESMExports} from 'node:module'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {wireHub} from '../../main/ts/core/hub/ports/index.ts'
import {stateFs} from '../../main/ts/adapters/state-fs/index.ts'
import {gitTransport} from '../../main/ts/adapters/store-git/transport.ts'
import {GitStore} from '../../main/ts/adapters/store-git/index.ts'
import {signCommit} from '../../main/ts/adapters/store-git/signing.ts'
import {validateRef} from '../../main/ts/adapters/store-git/remote/push.ts'
import {keysFile} from '../../main/ts/adapters/keys-file/index.ts'
import {runGit, ident} from '../../main/ts/adapters/store-git/run.ts'
import {createHub, adoptHub, openHub, openRoom, openContract, createRoom, attachRoom, roomNames, append, amendContract, deleteRoom, readProfileResource} from '../../main/ts/core/hub/rooms/index.ts'
import type {Hub, RoomV1 as Room} from '../../main/ts/core/hub/rooms/index.ts'
import {compose} from '../../main/ts/core/hub/protocol/index.ts'
import {loadRoom, loadState, linked} from '../../main/ts/core/hub/history/index.ts'
import * as Signals from '../../main/ts/core/hub/signals/index.ts'

const resources = fileURLToPath(new URL('../../main/resources', import.meta.url))
const fixture = (t: TestContext, signed = false) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ringi-room-streams-'))
  t.after(() => fs.rmSync(home, {recursive: true, force: true}))
  const build = {version: 'test', resources}
  const state = stateFs({root: home, build})
  let signerCalls = 0
  const transport = gitTransport(home, {signer: () => {signerCalls++; return keysFile(home)}})
  wireHub({build, state, transports: {git: transport}, store: 'git'})
  createHub('test', {signed})
  const H = openHub('test')
  const makeRoom = (name: string, remote?: string): Room => {
    const source = openContract(H).store
    const files = {'ROOM.md': `# ${name}\n`, 'profile.json': readProfileResource('a2a-1'),
      'members.json': JSON.stringify(signed ? {operator: {role: 'root'}} : {operator: {role: 'root'}, alice: {}, bob: {}}),
      ...(signed ? {allowed_signers: source.rootRoster!()} : {})}
    let R = createRoom(H, name, {who: 'operator', text: compose(`room ${name}`, [['To', '*'], ['Kind', 'room'], ['Room-Id', name]]), files, remote})
    if (signed) {
      for (const actor of ['alice', 'bob']) R.store.admit!(R.s, actor, R.store.joinKey!(R.s, actor).publicKey)
      R = openRoom(H, name)!
    }
    return R
  }
  return {home, H, makeRoom, state, signerCalls: () => signerCalls}
}
const reopen = (H: Hub, R: Room): Room => openRoom(H, R.name)!
const task = (subject: string) => compose(subject, [['To', 'bob'], ['Kind', 'task']])
const git = (R: Room, args: string[], input?: string, who = 'alice') => runGit(['--git-dir', path.join(R.hub.dir, 'rooms', R.name, R.endpoint.store.path, '.git'), ...args], {input, env: ident(who), where: R.hub.dir}).trim()
const corruptStream = (R: Room, body: string, who = 'alice', tree?: string): string => {
  const ref = `refs/heads/${who}/signals`
  const old = git(R, ['rev-parse', '--verify', ref])
  const sha = git(R, ['commit-tree', tree ?? git(R, ['rev-parse', `${old}^{tree}`]), '-p', old], body, who)
  git(R, ['update-ref', ref, sha, old])
  return sha
}

for (const signed of [false, true]) it(`routes independent rooms whose contracts stay frozen (${signed ? 'signed' : 'asserted'})`, t => {
  const f = fixture(t, signed), A = f.makeRoom('one'), B = f.makeRoom('two')
  assert.equal('store' in f.H, false)
  assert.notEqual(A.genesis, B.genesis)
  assert.equal(A.endpoint.hubGenesis, B.endpoint.hubGenesis)
  assert.deepEqual(roomNames(f.H), ['one', 'two'])
  const first = append(A, 'alice', task('first'), [{path: 'note.txt', content: 'one only', mode: '100644'}])
  assert.equal(A.store.signals(A.s)[0].signal, 'opened')
  assert.equal(A.store.file(first, 'note.txt').toString(), 'one only')
  assert.equal(B.store.extends(B.genesis, first), false)
  assert.throws(() => B.store.file(first, 'note.txt'))
  loadRoom(reopen(f.H, A), 'bob')
  const pin = loadState(A, 'bob').signals?.alice
  assert.ok(pin)
  const source = openContract(f.H)
  for (const invalid of [{...source.contract, version: '3.0'}, {...source.contract, capabilities: ['teleport/1']}]) {
    assert.throws(() => amendContract(f.H, 'operator', 'invalid', {'contract.json': JSON.stringify(invalid)}))
    assert.equal(openContract(f.H).main, source.main, 'invalid amendments move no source ref')
  }
  const amended = amendContract(f.H, 'operator', compose('minor', [['Kind', 'hub'], ['To', '*']]), {'contract.json': JSON.stringify({...source.contract, version: '2.1'})})
  assert.notEqual(openContract(f.H).main, source.main)
  const C = f.makeRoom('three')
  assert.equal(C.contractRev, amended)
  assert.equal(reopen(f.H, A).contractRev, source.main)
  assert.equal(reopen(f.H, B).contractRev, source.main)
  assert.equal(loadState(A, 'bob').signals?.alice, pin)
  assert.equal(A.store.file(first, 'note.txt').toString(), 'one only')
  deleteRoom(A)
  assert.deepEqual(roomNames(f.H), ['three', 'two'])
  assert.equal(openRoom(f.H, 'one', {quiet: true}), null)
  assert.equal(reopen(f.H, B).genesis, B.genesis)
  if (!signed) assert.equal(f.signerCalls(), 0)
})

it('uses logical idempotent signal tuples without changing the stream tree', t => {
  const f = fixture(t), R = f.makeRoom('stream')
  const id = append(R, 'alice', task('task'))
  const before = R.store.signalHeads(R.s)[0].head
  R.store.signal(R.s, 'alice', id, 'opened')
  assert.equal(R.store.signalHeads(R.s)[0].head, before)
  R.store.signal(R.s, 'bob', id, 'read')
  const {all} = linked(reopen(f.H, R), 'bob')
  assert.deepEqual(Signals.marksOn(R, all, Signals.check(R, all, R.store.signals(R.s))).get(id)?.read, ['bob'])
  assert.equal(git(R, ['for-each-ref', '--format=%(refname)', 'refs/tags/']), '')
  for (const {head} of R.store.signalHeads(R.s)) assert.equal(git(R, ['rev-parse', `${head}^{tree}`]), git(R, ['rev-parse', `${R.genesis}^{tree}`]))
})

it('ignores valid, corrupt and deleted legacy telemetry without removing refs, pins or durable alarms', t => {
  const f = fixture(t, true), origin = path.join(f.home, 'origin.git')
  runGit(['init', '-q', '--bare', '-b', 'main', origin], {where: f.home})
  const R = f.makeRoom('legacy', 'git+' + pathToFileURL(origin).href), store = R.store as GitStore
  const id = append(R, 'alice', task('accepted'))
  const tree = git(R, ['rev-parse', `${R.genesis}^{tree}`])
  const valid = signCommit(store.h, 'alice', git(R, ['commit-tree', tree, '-p', R.genesis],
    `Room: ${R.genesis}\nControl: ${R.head}\nTarget: ${id}\nState: working\nAlive: yes\nNext: 30\n`))
  const corrupt = git(R, ['commit-tree', tree, '-p', R.genesis], 'not telemetry facts\n', 'bob')
  const ref = 'refs/heads/alice/telemetry', pin = 'refs/ringi/remote-accepted/alice/telemetry'
  git(R, ['update-ref', ref, valid])
  git(R, ['update-ref', pin, valid])
  git(R, ['push', '-q', origin, `${valid}:${ref}`, `${corrupt}:refs/heads/bob/telemetry`])
  const alarmFile = path.join(store.dir, 'ringi', 'push-alarms.json')
  const durable = JSON.stringify({[ref]: 'legacy publication conflict'}) + '\n'
  fs.writeFileSync(alarmFile, durable)
  store.sync()
  assert.deepEqual(store.h.remoteAlarms, {})
  assert.deepEqual(loadRoom(reopen(f.H, R), 'bob').st.alarms, [])
  assert.deepEqual(store.signalHeads(R.s).map(x => x.actor), ['alice'])
  assert.equal(store.signals(R.s)[0].target, id)
  assert.equal(git(R, ['rev-parse', ref]), valid)
  assert.equal(git(R, ['rev-parse', pin]), valid)
  assert.equal(store.rev('refs/heads/bob/telemetry'), null, 'a fetched legacy stream is never promoted')
  assert.equal(git(R, ['rev-parse', 'refs/remotes/origin/bob/telemetry']), corrupt)
  assert.equal(fs.readFileSync(alarmFile, 'utf8'), durable)
  assert.throws(() => validateRef(store.h, ref, valid), /unknown actor stream/)
  git(R, ['push', '-q', origin, `:${ref}`, ':refs/heads/bob/telemetry'])
  store.sync()
  assert.deepEqual(store.h.remoteAlarms, {})
  assert.deepEqual(loadRoom(reopen(f.H, R), 'bob').st.alarms, [])
  assert.equal(git(R, ['rev-parse', ref]), valid)
  assert.equal(git(R, ['rev-parse', pin]), valid)
  assert.equal(fs.readFileSync(alarmFile, 'utf8'), durable)
  const current = {'refs/heads/alice/signals': 'current signal conflict', 'refs/heads/chat': 'current chat conflict', 'refs/heads/main': 'current main conflict'}
  fs.writeFileSync(alarmFile, JSON.stringify({...current, [ref]: 'legacy conflict', 'refs/heads/main/telemetry': 'unsupported alarm'}))
  const before = fs.readFileSync(alarmFile)
  store.sync()
  assert.deepEqual(store.h.remoteAlarms, {...current, 'refs/heads/main/telemetry': 'unsupported alarm'})
  assert.deepEqual(fs.readFileSync(alarmFile), before, 'the current alarm view never rewrites persisted evidence')
})

it('retries a retained signal tuple with the same commit and preserves legacy alarm evidence', t => {
  const f = fixture(t, true), origin = path.join(f.home, 'origin.git')
  runGit(['init', '-q', '--bare', '-b', 'main', origin], {where: f.home})
  const R = f.makeRoom('retry', 'git+' + pathToFileURL(origin).href), store = R.store as GitStore
  const id = append(R, 'alice', task('accepted')), ref = 'refs/heads/bob/signals'
  const alarmFile = path.join(store.dir, 'ringi', 'push-alarms.json'), legacy = {'refs/heads/alice/telemetry': 'legacy publication conflict'}
  fs.writeFileSync(alarmFile, JSON.stringify(legacy))
  const hook = path.join(origin, 'hooks', 'pre-receive')
  fs.writeFileSync(hook, '#!/bin/sh\nwhile read old new ref; do\n  if [ "$ref" = "refs/heads/bob/signals" ]; then exit 1; fi\ndone\n', {mode: 0o700})
  assert.throws(() => store.signal(R.s, 'bob', id, 'read'), /ALARM.*push rejected/)
  const retained = store.rev(ref)!
  assert.ok(retained)
  assert.equal(store.rev('refs/ringi/remote-accepted/bob/signals'), null)
  assert.deepEqual(store.signals(R.s).filter(x => x.actor === 'bob').map(x => x.id), [retained])
  assert.ok(JSON.parse(fs.readFileSync(alarmFile, 'utf8'))[ref])
  fs.rmSync(hook)
  store.signal(R.s, 'bob', id, 'read')
  assert.equal(store.rev(ref), retained)
  assert.equal(store.rev('refs/ringi/remote-accepted/bob/signals'), retained)
  assert.equal(runGit(['--git-dir', origin, 'rev-parse', ref], {where: f.home}).trim(), retained)
  assert.deepEqual(store.signals(R.s).filter(x => x.actor === 'bob').map(x => x.id), [retained])
  assert.deepEqual(JSON.parse(fs.readFileSync(alarmFile, 'utf8')), legacy)
  store.sync()
  assert.deepEqual(store.h.remoteAlarms, {})
})

it('stops semantic failures at the accepted stream prefix and detects its deletion', t => {
  const f = fixture(t), R = f.makeRoom('semantics')
  append(R, 'alice', task('accepted'))
  loadRoom(reopen(f.H, R), 'bob')
  const pin = loadState(R, 'bob').signals!.alice
  const plain = append(R, 'alice', compose('plain', [['To', 'bob']]))
  R.store.signal(R.s, 'alice', plain, 'opened')
  const later = append(R, 'alice', task('after failure'))
  const {logs, st} = loadRoom(reopen(f.H, R), 'bob')
  assert.equal(st.signals!.alice, pin)
  assert.match(st.alarms!.join('\n'), /did not make opened/)
  assert.ok(logs.get('alice')!.some(m => m.id === later))
  git(R, ['update-ref', 'refs/heads/alice/signals', R.genesis])
  const deleted = loadRoom(reopen(f.H, R), 'bob').st
  assert.equal(deleted.signals!.alice, pin)
  assert.match(deleted.alarms!.join('\n'), /deleted or rewritten/)
  assert.equal(git(R, ['rev-parse', `refs/ringi/accepted/${R.genesis}/bob/signals/alice`]), pin)
})

it('withholds an unfetched dependency without accepting its stream head', t => {
  const f = fixture(t), R = f.makeRoom('pending')
  append(R, 'alice', task('accepted'))
  loadRoom(reopen(f.H, R), 'bob')
  const pin = loadState(R, 'bob').signals!.alice
  corruptStream(R, `Room: ${R.genesis}\nControl: ${R.head}\nTarget: ${'a'.repeat(40)}\nSignal: opened\n`)
  const {st} = loadRoom(reopen(f.H, R), 'bob')
  assert.equal(st.signals!.alice, pin)
  assert.deepEqual(st.alarms, [])
})

it('withholds an unsigned signal stream suffix in a signed room', t => {
  const f = fixture(t, true), R = f.makeRoom('signed')
  const id = append(R, 'alice', task('accepted'))
  loadRoom(reopen(f.H, R), 'bob')
  const pin = loadState(R, 'bob').signals!.alice
  corruptStream(R, `Room: ${R.genesis}\nControl: ${R.head}\nTarget: ${id}\nSignal: taken\n`)
  const {st} = loadRoom(reopen(f.H, R), 'bob')
  assert.equal(st.signals!.alice, pin)
  assert.match(st.alarms!.join('\n'), /bad or missing signature/)
  assert.equal(R.store.signals(R.s).length, 1)
})

it('publishes and explicitly attaches a self-contained room without an operator contract source', t => {
  const f = fixture(t, true), origin = path.join(f.home, 'origin.git')
  runGit(['init', '-q', '--bare', '-b', 'main', origin], {where: f.home})
  const R = f.makeRoom('published', 'git+' + pathToFileURL(origin).href)
  const id = append(R, 'alice', task('over the wire'))
  const readerHome = path.join(f.home, 'reader'), build = {version: 'test', resources}
  const state = stateFs({root: readerHome, build})
  const transport = gitTransport(readerHome, {signer: () => keysFile(readerHome)})
  wireHub({build, state, transports: {git: transport}, store: 'git'})
  state.ensure()
  const {contract: _, ...catalogue} = f.H.d
  state.write(['hub', 'test', 'hub'], catalogue)
  const H = openHub('test'), replica = attachRoom(H, R.name, R.endpoint)
  assert.equal(H.d.contract, undefined)
  assert.throws(() => openContract(H), /no operator contract source/)
  assert.equal(replica.genesis, R.genesis)
  assert.equal(replica.store.logHead(replica.s, 'alice'), id)
  assert.equal(replica.store.signals(replica.s)[0].target, id)
  assert.equal(fs.existsSync(path.join(readerHome, 'keys')), false, 'public verification does not acquire private keys')
  const before = fs.readFileSync(path.join(readerHome, 'hub', 'test', 'rooms', R.name, 'endpoint.json'))
  assert.throws(() => attachRoom(H, R.name, {...R.endpoint, genesis: 'f'.repeat(40)}), /already pins another history/)
  assert.deepEqual(fs.readFileSync(path.join(readerHome, 'hub', 'test', 'rooms', R.name, 'endpoint.json')), before)
  assert.throws(() => attachRoom(H, 'wrong-name', {...R.endpoint, name: 'wrong-name'}), /chat|genesis subject/)
  assert.deepEqual(roomNames(H), ['published'])
})

it('adopts only identical hub pins and reserves room names across catalogues', t => {
  const f = fixture(t), R = f.makeRoom('unique')
  assert.equal(adoptHub({trust: 'asserted', genesis: f.H.d.genesis}).name, f.H.name)
  assert.throws(() => adoptHub({trust: 'signed', root: 'wrong', genesis: f.H.d.genesis}), /changes the trust or root/)
  const H = adoptHub({trust: 'asserted', genesis: 'c'.repeat(40)})
  assert.equal(H.name, 'c'.repeat(12))
  assert.equal(H.d.contract, undefined)
  assert.throws(() => adoptHub({trust: 'asserted', genesis: 'c'.repeat(12) + 'd'.repeat(28)}), /prefix conflicts/)
  assert.throws(() => createRoom(H, R.name, {who: 'operator', text: '', files: {}}), /already belongs/)
  assert.throws(() => attachRoom(H, R.name, {...R.endpoint, hubGenesis: H.d.genesis}), /already belongs/)
  assert.deepEqual(roomNames(f.H), ['unique'])
  assert.equal(f.signerCalls(), 0)
})

it('scans only the new immutable actor-stream suffix on a reused selected store', t => {
  const f = fixture(t), R = f.makeRoom('suffix')
  for (let i = 0; i < 5; i++) append(R, 'alice', task(`task ${i}`))
  const reader = reopen(f.H, R), old = new Set(reader.store.signals(reader.s).map(x => x.id))
  const original = childProcess.spawnSync, revisited: string[] = []
  const mock = t.mock.method(childProcess, 'spawnSync', (...args: Parameters<typeof childProcess.spawnSync>) => {
    const [, argv, opt] = args
    if (Array.isArray(argv) && argv.includes('cat-file') && argv.includes('--batch')) {
      for (const id of String((opt as {input?: string | Buffer})?.input ?? '').trim().split('\n')) if (old.has(id)) revisited.push(id)
    }
    return original(...args)
  })
  syncBuiltinESMExports()
  try {
    append(reader, 'alice', task('new suffix'))
    assert.equal(reopen(f.H, reader).store, reader.store)
    assert.equal(reader.store.signals(reader.s).length, 6)
    assert.deepEqual(revisited, [], 'existing stream facts were already verified; only the new suffix is read')
  } finally {mock.mock.restore(); syncBuiltinESMExports()}
})
