import {it} from 'node:test'
import type {TestContext} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import childProcess, {spawnSync} from 'node:child_process'
import type {SpawnSyncOptions} from 'node:child_process'
import {syncBuiltinESMExports} from 'node:module'
import {pathToFileURL} from 'node:url'
import {gitTransport} from '../../main/ts/adapters/store-git/transport.ts'
import {withTransportAuth} from '../../main/ts/adapters/store-git/auth.ts'
import {git, networkGit} from '../../main/ts/adapters/store-git/remote/git.ts'
import type {TransportAuth, SshIdentity} from '../../main/ts/adapters/store-git/auth.ts'
import type {Handle} from '../../main/ts/adapters/store-git/remote/types.ts'
import type {Descriptor, Genesis, RoomEndpoint} from '../../main/ts/core/hub/ports/store.ts'
import {GitStore} from '../../main/ts/adapters/store-git/index.ts'
import {keysFile} from '../../main/ts/adapters/keys-file/index.ts'

const temp = (t: TestContext) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ringi auth ' $(literal) "))
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}))
  return dir
}
const descriptor = (trust: Descriptor['trust'] = 'asserted'): Descriptor => ({schema: 'ringi-hub/3', name: 'team', trust, genesis: '', store: {type: 'git'}, contract: {path: 'contract'}})
const genesis: Genesis = d => ({files: {'contract.json': JSON.stringify({schema: 'ringi-hub', version: '2.0', protocol: 1, store: 'git/3', trust: d.trust, root: d.root})}, text: 'hub\n\nTo: *\nKind: hub\n'})
const fixture = (t: TestContext) => {
  const home = temp(t), identity = path.join(home, "selected identity ' $(literal)")
  assert.equal(spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', identity]).status, 0)
  const publicKey = fs.readFileSync(identity + '.pub', 'utf8').trim()
  const endpoint: RoomEndpoint = {schema: 'ringi-room/1', name: 'r', hubGenesis: '', genesis: '', store: {path: 'contract', remote: 'git+ssh://git@forge.test:2222/org/r.git'}, authRef: 'selected', hostKeys: [`[forge.test]:2222 ${publicKey}`]}
  const H: Handle = {name: 'team', dir: path.join(home, 'repo', '.git'), d: descriptor(), endpoint, auth: {resolve: () => ({type: 'file', path: identity})}}
  return {home, identity, publicKey, endpoint, H}
}
const leftovers = (H: Handle) => fs.existsSync(path.join(H.dir, 'ringi')) ? fs.readdirSync(path.join(H.dir, 'ringi')).filter(n => n.startsWith('ssh-')) : []
const sshConfig = (command: string) => {
  // ssh -G resolves the actual OpenSSH configuration without making a connection.
  const r = spawnSync('sh', ['-c', command + ' -G forge.test'], {encoding: 'utf8'})
  assert.equal(r.status, 0, r.stderr)
  return new Map(r.stdout.trim().split('\n').map(line => {const at = line.indexOf(' '); return [line.slice(0, at), line.slice(at + 1)]}))
}

it('local construction, Git reads and asserted Signer stay independent of TransportAuth', t => {
  const home = temp(t), d = descriptor()
  let resolved = 0
  const auth: TransportAuth = {resolve: () => {resolved++; throw new Error('remote only')}}
  const transport = gitTransport(home, {auth, signer: () => {throw new Error('asserted must not create a signer')}})
  const at = path.join(home, 'hub'), source = transport.create(at, d, genesis).store as GitStore
  const endpoint: RoomEndpoint = {schema: 'ringi-room/1', name: 'r', hubGenesis: d.genesis, genesis: '', store: {path: 'contract'}, authRef: 'opaque'}
  const store = transport.open(at, d, endpoint) as GitStore
  assert.equal(store.contractHead(), source.contractHead())
  assert.match(git(store.h, ['show', 'main:contract.json']), /git\/3/)
  assert.equal(resolved, 0)
  assert.equal(fs.existsSync(path.join(home, 'keys')), false)
})

it('real OpenSSH config uses only the selected file identity and exact port pin with safely quoted paths', t => {
  const {H, identity, publicKey} = fixture(t), before = fs.readFileSync(identity)
  let knownFile = ''
  withTransportAuth(H, env => {
    const config = sshConfig(env.GIT_SSH_COMMAND!)
    assert.equal(config.get('identityfile'), identity)
    assert.equal(config.get('identityagent'), 'none')
    for (const [option, value] of [['batchmode', 'yes'], ['identitiesonly', 'yes'], ['stricthostkeychecking', 'true'], ['updatehostkeys', 'false'], ['globalknownhostsfile', os.devNull], ['passwordauthentication', 'no'], ['kbdinteractiveauthentication', 'no']]) assert.equal(config.get(option), value)
    knownFile = config.get('userknownhostsfile')!
    assert.equal(fs.readFileSync(knownFile, 'utf8'), `[forge.test]:2222 ${publicKey.split(' ').slice(0, 2).join(' ')}\n`)
    assert.equal(fs.statSync(knownFile).mode & 0o777, 0o600)
    assert.equal(env.SSH_AUTH_SOCK, undefined)
  })
  assert.equal(fs.existsSync(knownFile), false)
  assert.deepEqual(leftovers(H), [])
  assert.deepEqual(fs.readFileSync(identity), before)
})

it('agent identity selects its explicit socket and a temporary public key, with cleanup after failure', t => {
  const {H, home, publicKey} = fixture(t), socket = path.join(home, 'agent socket')
  H.auth = {resolve: () => ({type: 'agent', socket, publicKey})}
  let publicFile = ''
  assert.throws(() => withTransportAuth(H, env => {
    const config = sshConfig(env.GIT_SSH_COMMAND!)
    assert.equal(config.get('identityagent'), socket)
    assert.equal(env.SSH_AUTH_SOCK, socket)
    publicFile = config.get('identityfile')!
    assert.equal(fs.readFileSync(publicFile, 'utf8').trim(), publicKey.split(' ').slice(0, 2).join(' '))
    assert.equal(fs.statSync(publicFile).mode & 0o777, 0o600)
    throw new Error('transport failed')
  }), /transport failed/)
  assert.equal(fs.existsSync(publicFile), false)
  assert.deepEqual(leftovers(H), [])
})

it('refuses missing or mismatched pins and bindings before contacting a provider or creating temporary files', t => {
  const {H, endpoint, publicKey} = fixture(t)
  let calls = 0
  H.auth = {resolve: () => {calls++; throw new Error('must not resolve')}}
  for (const hostKeys of [undefined, [], [`forge.test ${publicKey}`], [`[forge.test]:2223 ${publicKey}`], [`*.test ${publicKey}`], [`[forge.test]:2222 ${publicKey}\nextra`]]) {
    endpoint.hostKeys = hostKeys
    assert.throws(() => withTransportAuth(H, () => assert.fail('no remote call')), /hostKeys|host pin|known_hosts/)
  }
  endpoint.hostKeys = [`[forge.test]:2222 ${publicKey}`]
  delete endpoint.authRef
  assert.throws(() => withTransportAuth(H, () => assert.fail()), /authRef/)
  endpoint.authRef = 'selected'; delete H.auth
  assert.throws(() => withTransportAuth(H, () => assert.fail()), /injected TransportAuth/)
  assert.equal(calls, 0)
  assert.deepEqual(leftovers(H), [])
})

it('does not treat API credentials or pins as a contract SSH credential, and refuses an SSH binding on HTTPS', t => {
  const {H, endpoint, publicKey} = fixture(t)
  H.d.access = {address: 'forgejo+https://forge.test/org', authRef: '/operator/api-token', hostKeys: [`forge.test ${publicKey}`]}
  H.d.contract!.remote = 'git+ssh://git@forge.test/org/main.git'
  delete H.endpoint
  assert.throws(() => withTransportAuth(H, () => assert.fail()), /endpoint authRef/)
  H.endpoint = endpoint
  endpoint.store.remote = 'git+https://forge.test/org/r.git'
  assert.throws(() => withTransportAuth(H, () => assert.fail()), /only for SSH/)
  delete endpoint.authRef
  let resolved = false
  H.auth = {resolve: () => {resolved = true; throw new Error('HTTPS does not resolve SSH')}}
  assert.equal(withTransportAuth(H, env => Object.keys(env).length), 0)
  assert.equal(resolved, false)
})

it('cleans up invalid provider results and rejects paths that OpenSSH would expand', t => {
  const {H, home} = fixture(t)
  for (const identity of [{type: 'file', path: 'relative'}, {type: 'file', path: path.join(home, '%h')}, {type: 'agent', socket: path.join(home, '${OTHER}'), publicKey: 'bad'}, {type: 'agent', socket: home, publicKey: 'bad'}, {type: 'other'}]) {
    H.auth = {resolve: () => identity as SshIdentity}
    assert.throws(() => withTransportAuth(H, () => assert.fail()), /absolute|public key|unsupported/)
    assert.deepEqual(leftovers(H), [])
  }
})

it('managed remote Git replaces inherited SSH commands and cleans up on a command timeout', t => {
  const {H} = fixture(t), saved = Object.fromEntries(['GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_SSH_VARIANT', 'SSH_AUTH_SOCK'].map(k => [k, process.env[k]]))
  Object.assign(process.env, {GIT_SSH: '/hostile', GIT_SSH_COMMAND: 'hostile --command', GIT_SSH_VARIANT: 'plink', SSH_AUTH_SOCK: '/foreign-agent'})
  const mock = t.mock.method(childProcess, 'spawnSync', (cmd: string, args: readonly string[], opt: SpawnSyncOptions) => {
    assert.equal(cmd, 'git'); assert.ok(args.includes('fetch'))
    assert.notEqual(opt.env?.GIT_SSH_COMMAND, 'hostile --command')
    assert.equal(opt.env?.GIT_SSH, undefined)
    assert.equal(opt.env?.GIT_SSH_VARIANT, 'ssh')
    assert.equal(opt.env?.SSH_AUTH_SOCK, undefined)
    return {error: Object.assign(new Error('timeout'), {code: 'ETIMEDOUT'}), status: null, signal: 'SIGTERM', stdout: '', stderr: ''}
  })
  syncBuiltinESMExports()
  try {assert.throws(() => networkGit(H, ['fetch', H.endpoint!.store.remote!]), /git timed out/)}
  finally {
    mock.mock.restore(); syncBuiltinESMExports()
    for (const [key, value] of Object.entries(saved)) {if (value === undefined) delete process.env[key]; else process.env[key] = value}
  }
  assert.deepEqual(leftovers(H), [])
})

it('signed sync, push and lost-ack retry use the same explicit auth while verification stays local', t => {
  const {home, identity, publicKey} = fixture(t), d = descriptor('signed'), context = keysFile(home)
  let resolved = 0
  const transport = gitTransport(home, {signer: context, auth: {resolve: (ref, address) => {
    assert.equal(ref, 'selected'); assert.equal(address, 'git+ssh://git@forge.test:2222/org/r.git')
    resolved++; return {type: 'file', path: identity}
  }}})
  const at = path.join(home, 'hub'), source = transport.create(at, d, genesis).store
  const endpoint: RoomEndpoint = {schema: 'ringi-room/1', name: 'r', hubGenesis: d.genesis, genesis: '', store: {path: 'store'}, authRef: 'selected', hostKeys: [`[forge.test]:2222 ${publicKey}`]}
  const store = transport.fork(path.join(at, 'room'), d, source, endpoint) as GitStore
  store.createRoom('r', 'operator', 'room r\n\nTo: *\nKind: room\nRoom-Id: 0123456789abcdef0123456789abcdef\n', {'ROOM.md': '# r\n', 'members.json': '{"operator":{"role":"root"}}', allowed_signers: store.rootRoster()})
  endpoint.genesis = store.room('r')!.genesis
  assert.equal(resolved, 0)
  const remote = path.join(home, 'remote.git')
  assert.equal(spawnSync('git', ['init', '--bare', '-q', remote]).status, 0)
  const fileUrl = pathToFileURL(remote).href
  assert.equal(spawnSync('git', ['--git-dir', store.dir, 'push', '-q', fileUrl, 'refs/heads/main', 'refs/heads/chat']).status, 0)
  endpoint.store.remote = 'git+ssh://git@forge.test:2222/org/r.git'
  const original = childProcess.spawnSync
  let lost = false, remoteCalls = 0
  const mock = t.mock.method(childProcess, 'spawnSync', (cmd: string, args: readonly string[], opt: SpawnSyncOptions) => {
    const network = cmd === 'git' && args.includes('ssh://git@forge.test:2222/org/r.git')
    if (!network) {assert.equal(opt.env?.GIT_SSH_COMMAND, undefined); return original(cmd, args, opt)}
    remoteCalls++
    const config = sshConfig(opt.env!.GIT_SSH_COMMAND!)
    assert.equal(config.get('identityfile'), identity)
    const result = original(cmd, args.map(a => a === 'ssh://git@forge.test:2222/org/r.git' ? fileUrl : a), opt)
    if (args.includes('push') && !lost) {lost = true; assert.equal(result.status, 0, String(result.stderr)); return {...result, status: 1, stderr: 'ack lost'} }
    return result
  })
  syncBuiltinESMExports()
  try {
    store.sync()
    const sha = store.append(store.room('r')!, 'operator', 'one publication\n\nTo: *\n', [])
    assert.equal(store.verifyLog(store.room('r')!, 'operator', sha), null)
    assert.equal(original('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/chat'], {encoding: 'utf8'}).stdout.toString().trim(), sha)
    assert.equal(lost, true)
    assert.ok(remoteCalls >= 4)
    assert.equal(resolved, remoteCalls)
    assert.deepEqual(store.h.remoteAlarms, {})
  } finally {mock.mock.restore(); syncBuiltinESMExports()}
  assert.deepEqual(leftovers(store.h), [])
})

it('creates one opaque signed identity before any Store, without a repository or admission', t => {
  const home = temp(t), signer = keysFile(home), d = descriptor('signed')
  const original = childProcess.spawnSync
  const mock = t.mock.method(childProcess, 'spawnSync', (cmd: string, args: readonly string[], opt: SpawnSyncOptions) => {
    assert.notEqual(cmd, 'git', 'identity must not open a repository')
    return original(cmd, args, opt)
  })
  syncBuiltinESMExports()
  const transport = gitTransport(home, {signer: {resolve: signer.resolve, signer: signer.signer}})
  try {
    const first = transport.identity!(d, 'codex'), second = transport.identity!(d, 'codex')
    assert.deepEqual(first, second)
    assert.match(first.publicKey, /^ssh-ed25519 /)
    assert.match(first.fingerprint, /^SHA256:/)
    assert.equal(fs.existsSync(path.join(home, 'hub')), false)
    assert.equal(fs.existsSync(path.join(home, 'keys', 'team', 'operator')), false)
    assert.throws(() => transport.identity!(d, '../foreign'), /bad agent/)
  } finally {mock.mock.restore(); syncBuiltinESMExports()}
})

it('an asserted identity request never creates a Signer or key', t => {
  const home = temp(t), transport = gitTransport(home, {signer: () => {throw new Error('asserted must not resolve signer')}})
  assert.throws(() => transport.identity!(descriptor(), 'codex'), /requires a signed hub/)
  assert.equal(fs.existsSync(path.join(home, 'keys')), false)
  assert.throws(() => gitTransport(home).identity!(descriptor('signed'), 'codex'), /injected Signer/)
})

it('classifies only explicit SSH denial; timeout, missing repo, host/config and history diagnostics stay failures', t => {
  const {H} = fixture(t)
  let stderr = 'git@forge.test: Permission denied (publickey).', error: NodeJS.ErrnoException | undefined
  const mock = t.mock.method(childProcess, 'spawnSync', () => ({status: 128, signal: null, error, pid: 0, stdout: '', stderr, output: []}))
  syncBuiltinESMExports()
  try {
    for (const verb of ['fetch', 'ls-remote']) assert.throws(() => networkGit(H, [verb, 'ssh://git@forge.test:2222/org/r.git']), {code: 'denied'})
    assert.equal(networkGit(H, ['push', 'ssh://git@forge.test:2222/org/r.git'], {ok: true}).status, 128, 'push rejection retains its existing alarm path')
    for (stderr of ['Host key verification failed.', 'Bad configuration option', 'ERROR: Repository not found.', 'fatal: Could not read from remote repository.', 'ALARM accepted main changed', 'Permission denied opening a local file']) {
      for (const verb of ['fetch', 'ls-remote']) assert.throws(() => networkGit(H, [verb, 'ssh://git@forge.test:2222/org/r.git']), (e: unknown) => {
        assert.notEqual((e as NodeJS.ErrnoException).code, 'denied'); return true
      })
    }
    stderr = 'Permission denied (publickey).'; error = Object.assign(new Error('timed out'), {code: 'ETIMEDOUT'})
    for (const verb of ['fetch', 'ls-remote']) assert.throws(() => networkGit(H, [verb, 'ssh://git@forge.test:2222/org/r.git']), {code: 'ETIMEDOUT'})
  } finally {mock.mock.restore(); syncBuiltinESMExports()}
  assert.deepEqual(leftovers(H), [])
})

for (const deniedAt of ['ls-remote', 'fetch']) it(`a fresh attachment denied at ${deniedAt} removes only its staging repository and installs no endpoint or history`, t => {
  const {home, endpoint, identity, publicKey} = fixture(t), context = keysFile(home), d = descriptor('signed')
  d.root = publicKey; d.genesis = 'a'.repeat(40)
  endpoint.hubGenesis = d.genesis; endpoint.genesis = 'b'.repeat(40)
  const transport = gitTransport(home, {signer: context, auth: {resolve: () => ({type: 'file', path: identity})}})
  const at = path.join(home, 'fresh-room'), original = childProcess.spawnSync
  const calls: string[] = []
  const mock = t.mock.method(childProcess, 'spawnSync', (cmd: string, args: readonly string[], opt: SpawnSyncOptions) => {
    if (cmd === 'git' && (args.includes('ls-remote') || args.includes('fetch'))) {
      const verb = args.includes('ls-remote') ? 'ls-remote' : 'fetch'; calls.push(verb)
      if (verb === deniedAt) return {status: 128, signal: null, error: undefined, pid: 0, stdout: '', stderr: 'Permission denied (publickey).', output: []}
      assert.equal(verb, 'ls-remote')
      return {status: 0, signal: null, error: undefined, pid: 0, stdout: `${d.genesis}\trefs/heads/main\n${endpoint.genesis}\trefs/heads/chat\n`, stderr: '', output: []}
    }
    assert.ok(!args.some(a => a.includes('ssh://')), 'all SSH transport commands must stay inside this fixture')
    return original(cmd, args, opt)
  })
  syncBuiltinESMExports()
  try {assert.throws(() => transport.attachRoom(at, d, endpoint), {code: 'denied'})}
  finally {mock.mock.restore(); syncBuiltinESMExports()}
  assert.deepEqual(calls, deniedAt === 'ls-remote' ? ['ls-remote'] : ['ls-remote', 'fetch'])
  assert.equal(fs.existsSync(at), false)
  assert.equal(fs.readdirSync(home).some(n => n.startsWith('fresh-room.attach.')), false)
  assert.equal(fs.existsSync(path.join(home, 'keys')), false)
})
