import {it} from 'node:test'
import type {TestContext} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {keysFile} from '../../main/ts/adapters/keys-file/index.ts'
import {gitTransport} from '../../main/ts/adapters/transport-git/transport.ts'
import {GitStore} from '../../main/ts/adapters/transport-git/index.ts'
import * as Remote from '../../main/ts/adapters/transport-git/remote.ts'
import {git} from '../../main/ts/adapters/transport-git/remote/git.ts'
import {identityKey, signerLine} from '../../main/ts/adapters/transport-git/remote/keys.ts'
import type {Descriptor, Genesis} from '../../main/ts/core/hub/ports/store.ts'
import type {SigningContext, SignRequest} from '../../main/ts/core/signing/index.ts'

const temp = (t: TestContext) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ringi-signer-'))
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}))
  return dir
}
const genesis: Genesis = d => ({files: {
  'contract.json': JSON.stringify({schema: 'ringi-hub', trust: d.trust, root: d.root}),
  'authority.json': '{"decide":{}}',
}, text: 'hub fixture\n\nTo: *\nKind: hub\n'})
const descriptor = (trust: Descriptor['trust']): Descriptor => ({schema: 'ringi-hub/2', name: 'team', trust, store: {type: 'git', path: 'store'}})

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
      return corrupt ? {...signature, bytes: Buffer.from('malformed signature')} : signature
    },
  }}
  const d = descriptor('signed'), transport = gitTransport(home, {signer: context})
  const created = transport.create(path.join(home, 'hub', 'team'), d, genesis), store = created.store as GitStore
  assert.equal(created.custody, null)
  assert.equal(Remote.verifyHub(store.h)?.genesis, d.genesis)
  store.createRoom('r', 'operator', 'room r\n\nTo: *\nKind: room\nRoom-Id: 0123456789abcdef0123456789abcdef\n', {
    'ROOM.md': '# r\n', 'members.json': '{"operator":{"role":"root"}}', allowed_signers: store.rootRoster(),
  })
  let room = store.room('r')!
  const actor = identityKey(store.h, 'codex', home, true)
  assert.equal(store.joinKey(room, 'codex').admitted, false)
  store.admit(room, 'codex', actor.line)
  room = store.room('r')!
  assert.equal(store.joinKey(room, 'codex').admitted, true)
  const binary = path.join(home, 'binary-input')
  fs.writeFileSync(binary, Buffer.from([255, 0, 128]))
  const sha = store.append(room, 'codex', 'binary attachment\n\nTo: operator\nKind: task\n', [{path: 'binary', mode: '100644', file: binary}])
  assert.equal(store.verifyLog(room, 'codex', sha), null)
  assert.deepEqual(store.file(sha, 'binary'), Buffer.from([255, 0, 128]))
  store.signal(room, 'codex', sha, `opened.${sha.slice(0, 12)}`)
  assert.equal(store.signals(room).length, 1)
  const beat = store.heartbeat(room, 'codex', sha, 'Session: test\nState: waiting\nAlive: yes\nNext: 60\n')
  assert.equal(Remote.verifyHeartbeat(store.h, {name: 'r', ref: 'refs/heads/r', genesis: room.genesis, head: room.head}, `refs/tags/codex.heartbeat.${room.genesis.slice(0, 12)}`, beat), null)
  assert(calls.length >= 6)
  assert(calls.every(r => r.namespace === 'git' && r.interaction === 'forbidden' && !String(r.key).includes(home)))
  const tip = store.rev('refs/heads/r')
  deny = true
  assert.throws(() => store.append(room, 'codex', 'denied\n\nTo: operator\nKind: task\n', []), /fixture denied/)
  assert.equal(store.rev('refs/heads/r'), tip)
  assert.throws(() => store.signal(room, 'codex', sha, `read.${sha.slice(0, 12)}`), /fixture denied/)
  assert.equal(git(store.h, ['rev-parse', '--verify', `refs/tags/codex.read.${sha.slice(0, 12)}`], {ok: true}).status, 128)
  deny = false
  corrupt = true
  assert.throws(() => store.append(room, 'codex', 'corrupt\n\nTo: operator\nKind: task\n', []), /bad or missing signature/)
  assert.equal(store.rev('refs/heads/r'), tip)
  corrupt = false
  const replacement = keysFile(path.join(home, 'replacement'))
  replacement.resolve('team', 'operator', true)
  store.h.signing = replacement
  assert.throws(() => store.amendContract('operator', 'wrong root', {}), /does not match/)
  assert.equal(store.contractHead(), d.genesis)
  assert.match(signerLine('codex', actor), /namespaces="git"/)
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
