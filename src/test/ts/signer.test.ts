import {it} from 'node:test'
import type {TestContext} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {keysFile} from '../../main/ts/adapters/keys-file/index.ts'
import {gitTransport} from '../../main/ts/adapters/store-git/transport.ts'
import {GitStore} from '../../main/ts/adapters/store-git/index.ts'
import * as Remote from '../../main/ts/adapters/store-git/remote.ts'
import {git} from '../../main/ts/adapters/store-git/remote/git.ts'
import {identityKey, signerLine} from '../../main/ts/adapters/store-git/remote/keys.ts'
import type {Descriptor, Genesis, RoomEndpoint} from '../../main/ts/core/hub/ports/store.ts'
import type {SigningContext, SignRequest} from '../../main/ts/core/signing/index.ts'

const temp = (t: TestContext) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ringi-signer-'))
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}))
  return dir
}
const genesis: Genesis = d => ({files: {
  'contract.json': JSON.stringify({schema: 'ringi-hub', version: '2.0', protocol: 1, store: 'git/3', trust: d.trust, root: d.root}),
}, text: 'hub fixture\n\nTo: *\nKind: hub\n'})
const descriptor = (trust: Descriptor['trust']): Descriptor => ({schema: 'ringi-hub/3', name: 'team', trust, genesis: '', store: {type: 'git'}, contract: {path: 'contract'}})

it('keys-file signs exact binary bytes, derives identity, and refuses foreign refs, deadlines and encrypted custody', t => {
  const home = temp(t), context = keysFile(home)
  assert.equal(fs.existsSync(path.join(home, 'keys')), false)
  const key = context.resolve('team', 'operator', true), identity = context.signer.publicIdentity(key)
  fs.writeFileSync(context.custody!('team', 'operator')! + '.pub', 'untrusted sidecar')
  assert.deepEqual(context.signer.publicIdentity(key), identity)
  const payload = Buffer.from([0, 255, 128, 10, 13, 65])
  const request: SignRequest = {key, payload, namespace: 'git', interaction: 'forbidden', deadline: performance.now() + 30000}
  const signature = context.signer.sign(request), file = path.join(home, 'signature'), allowed = path.join(home, 'allowed')
  fs.writeFileSync(file, signature.bytes)
  fs.writeFileSync(allowed, `operator namespaces="git" ${identity.key}\n`)
  const verified = spawnSync('ssh-keygen', ['-Y', 'verify', '-f', allowed, '-I', 'operator', '-n', 'git', '-s', file], {input: payload, encoding: 'utf8'})
  assert.equal(verified.status, 0, verified.stderr)
  assert.throws(() => context.signer.sign({...request, deadline: 0}), {reason: 'timeout'})
  assert.throws(() => keysFile(home).signer.sign(request), {reason: 'denied'})
  assert.throws(() => context.resolve('../escape', 'operator', true), {reason: 'denied'})
  const encrypted = context.custody!('team', 'encrypted')!
  assert.equal(spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', 'secret-fixture', '-f', encrypted]).status, 0)
  assert.throws(() => context.signer.publicIdentity(context.resolve('team', 'encrypted')), {reason: 'interaction-required'})
})

it('injected Signer produces verifiable commits, admission, signals and heartbeat without exporting its custody path', t => {
  const home = temp(t), custody = keysFile(home), calls: SignRequest[] = []
  let deny = false, corrupt = false
  const context: SigningContext = {resolve: custody.resolve, signer: {
    publicIdentity: custody.signer.publicIdentity,
    sign: r => {
      calls.push(r)
      if (deny) throw Object.assign(new Error('fixture denied'), {reason: 'denied'})
      const signature = custody.signer.sign(r)
      return corrupt ? {...signature, bytes: Buffer.from(Buffer.from(signature.bytes).toString().replace(/\n([A-Za-z0-9+/])/, (_, first) => '\n' + (first === 'A' ? 'B' : 'A')))} : signature
    },
  }}
  const d = descriptor('signed'), transport = gitTransport(home, {signer: context})
  const created = transport.create(path.join(home, 'hub', 'team'), d, genesis)
  const endpoint: RoomEndpoint = {schema: 'ringi-room/1', name: 'r', hubGenesis: d.genesis, genesis: '', store: {path: 'store'}}
  const store = transport.fork(path.join(home, 'hub', 'team', 'rooms', 'r'), d, created.store, endpoint) as GitStore
  assert.equal(created.custody, null)
  assert.equal(Remote.verifyHub(store.h)?.genesis, d.genesis)
  store.createRoom('r', 'operator', 'room r\n\nTo: *\nKind: room\nRoom-Id: 0123456789abcdef0123456789abcdef\n', {
    'ROOM.md': '# r\n', 'members.json': '{"operator":{"role":"root"}}', allowed_signers: store.rootRoster(),
  })
  let room = store.room('r')!
  const actor = identityKey(store.h, 'codex', true)
  assert.equal(store.joinKey(room, 'codex').admitted, false)
  store.admit(room, 'codex', actor.line)
  room = store.room('r')!
  assert.equal(store.joinKey(room, 'codex').admitted, true)
  const binary = path.join(home, 'binary-input')
  fs.writeFileSync(binary, Buffer.from([255, 0, 128]))
  const sha = store.append(room, 'codex', 'binary attachment\n\nTo: operator\nKind: task\n', [{path: 'binary', mode: '100644', file: binary}])
  assert.equal(store.verifyLog(room, 'codex', sha), null)
  assert.deepEqual(store.file(sha, 'binary'), Buffer.from([255, 0, 128]))
  store.signal(room, 'codex', sha, 'opened')
  assert.equal(store.signals(room).length, 1)
  const beat = store.heartbeat(room, 'codex', sha, 'State: waiting\nAlive: yes\nNext: 60\n')
  Remote.validateStream(store.h, {name: 'r', ref: 'refs/heads/chat', genesis: room.genesis, head: room.head}, 'refs/heads/codex/telemetry', beat)
  assert(calls.length >= 6)
  assert(calls.every(r => r.namespace === 'git' && r.interaction === 'forbidden' && !String(r.key).includes(home)))
  const tip = store.rev('refs/heads/chat')
  const bob = identityKey(store.h, 'bob', true)
  const refs = () => git(store.h, ['for-each-ref', '--format=%(refname) %(objectname)'])
  const before = refs()
  deny = true
  assert.throws(() => store.append(room, 'codex', 'denied\n\nTo: operator\nKind: task\n', []), /fixture denied/)
  assert.equal(store.rev('refs/heads/chat'), tip)
  assert.throws(() => store.signal(room, 'codex', sha, 'read'), /fixture denied/)
  assert.equal(refs(), before)
  assert.throws(() => store.heartbeat(room, 'codex', sha, 'State: working\nAlive: yes\nNext: 60\n'), /fixture denied/)
  assert.throws(() => store.admit(room, 'bob', bob.line), /fixture denied/)
  assert.equal(refs(), before)
  deny = false
  corrupt = true
  assert.throws(() => store.append(room, 'codex', 'corrupt\n\nTo: operator\nKind: task\n', []), /bad or missing signature/)
  assert.equal(store.rev('refs/heads/chat'), tip)
  assert.throws(() => store.signal(room, 'codex', sha, 'read'), /bad or missing signature/)
  assert.throws(() => store.heartbeat(room, 'codex', sha, 'State: working\nAlive: yes\nNext: 60\n'), /bad or missing signature/)
  assert.throws(() => store.admit(room, 'bob', bob.line), /bad or missing signature/)
  assert.equal(refs(), before)
  corrupt = false
  const replacement = keysFile(path.join(home, 'replacement'))
  replacement.resolve('team', 'operator', true)
  const source = created.store as GitStore
  source.h.signing = replacement
  assert.throws(() => source.amendContract('operator', 'wrong root', {}), /does not match/)
  assert.equal(store.contractHead(), d.genesis)
  assert.match(signerLine('codex', actor), /namespaces="git"/)
})

it('signed entrypoints refuse missing Signer even when local custody files exist, preserving every ref', t => {
  const home = temp(t), d = descriptor('signed'), context = keysFile(home)
  const at = path.join(home, 'hub', 'team')
  const transport = gitTransport(home, {signer: context})
  const source = transport.create(at, d, genesis).store
  const endpoint: RoomEndpoint = {schema: 'ringi-room/1', name: 'r', hubGenesis: d.genesis, genesis: '', store: {path: 'store'}}
  const store = transport.fork(path.join(at, 'rooms', 'r'), d, source, endpoint) as GitStore
  store.createRoom('r', 'operator', 'room r\n\nTo: *\nKind: room\nRoom-Id: 0123456789abcdef0123456789abcdef\n', {
    'ROOM.md': '# r\n', 'members.json': '{"operator":{"role":"root"}}', allowed_signers: store.rootRoster(),
  })
  const room = store.room('r')!, refs = git(store.h, ['for-each-ref', '--format=%(refname) %(objectname)'])
  assert(fs.existsSync(context.custody!('team', 'operator')!))
  assert.throws(() => gitTransport(home).open(at, d), /injected Signer/)
  assert.throws(() => gitTransport(home).create(at, d, genesis), /injected Signer/)
  assert.throws(() => new GitStore(at, d, home), /injected Signer/)
  assert.throws(() => GitStore.create(at, d, home, {}, 'unsigned bootstrap'), /injected Signer/)
  delete store.h.signing
  assert.throws(() => identityKey(store.h, 'operator'), /injected Signer/)
  assert.throws(() => store.append(room, 'operator', 'must not sign\n\nTo: *\n', []), /injected Signer/)
  assert.throws(() => store.signal(room, 'operator', room.genesis, 'read'), /injected Signer/)
  assert.throws(() => store.heartbeat(room, 'operator', room.genesis, 'State: working\nAlive: yes\nNext: 60\n'), /injected Signer/)
  assert.equal(git(store.h, ['for-each-ref', '--format=%(refname) %(objectname)']), refs)
  const fresh = path.join(home, 'fresh')
  assert.throws(() => GitStore.create(fresh, descriptor('signed'), home, {}, 'unsigned bootstrap'), /injected Signer/)
  assert.equal(fs.existsSync(fresh), false)
})

it('asserted transport never constructs a Signer or generates keys', t => {
  const home = temp(t), d = descriptor('asserted')
  const transport = gitTransport(home, {signer: () => {throw new Error('asserted must not construct custody')}})
  const {store, custody} = transport.create(path.join(home, 'hub', 'team'), d, genesis)
  assert.equal(custody, null)
  assert.equal(store.trust, 'asserted')
  assert.equal(transport.open(path.join(home, 'hub', 'team'), d).contractHead(), store.contractHead())
  assert.equal(fs.existsSync(path.join(home, 'keys')), false)
})
