// Independent signed writers and file:// replicas: the hub cannot supply its own trust anchor.
import {describe, it} from 'node:test'
import type {TestContext} from 'node:test'
import type {SpawnSyncOptions, SpawnSyncReturns} from 'node:child_process'
import type {Descriptor} from '../../main/ts/core/hub/ports/store.ts'
import type {asJson} from '../../main/ts/core/hub/usecases/view.ts'
import type {Profile} from '../../main/ts/core/hub/work/index.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import childProcess, {spawn, spawnSync} from 'node:child_process'
import {syncBuiltinESMExports} from 'node:module'
import {fileURLToPath, pathToFileURL} from 'node:url'
import * as Remote from '../../main/ts/adapters/transport-git/remote.ts'
import {GitStore, runGit} from '../../main/ts/adapters/transport-git/index.ts'
import {keysFile} from '../../main/ts/adapters/keys-file/index.ts'
import {identityKey} from '../../main/ts/adapters/transport-git/remote/keys.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(HERE, '../../../target/esm/cli.js')
const BASE = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|CODEX|CURSOR|RINGI_|GIT_)/.test(k)))
const ENV = {...BASE, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', RINGI_PULSE: 'off'}
type GitOpt = {input?: string, env?: NodeJS.ProcessEnv, ok?: boolean}
function git(dir: string, args: string[], opt: GitOpt & {ok: true}): SpawnSyncReturns<string>
function git(dir: string, args: string[], opt?: GitOpt): string
function git(dir: string, args: string[], opt: GitOpt = {}): string | SpawnSyncReturns<string> {
  const r = spawnSync('git', ['--git-dir', dir, '-c', 'core.hooksPath=' + os.devNull, ...args], {
    encoding: 'utf8', input: opt.input, env: {...ENV, ...opt.env}, maxBuffer: 16 * 1024 * 1024,
  })
  if (!opt.ok) assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
  return opt.ok ? r : r.stdout
}
type Hub = Remote.Handle & {
  git: { (args: string[], opt: GitOpt & {ok: true}): SpawnSyncReturns<string>; (args: string[], opt?: GitOpt): string }
  rev: (ref: string) => string | null
  isAncestor: (a: string, b: string) => boolean
}
const hub = (home: string, name = 'team'): Hub => {
  const dir = path.join(home, 'hub', name, 'store', '.git')
  const file = path.join(home, 'hub', name, 'hub.json')
  const d: Descriptor = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {schema: 'ringi-hub/2', name, trust: 'signed', store: {type: 'git', path: 'store'}}
  if (d.store.remote) git(dir, ['remote', 'add', 'origin', d.store.remote], {ok: true})
  const rev = (ref: string) => { const r = git(dir, ['rev-parse', '-q', '--verify', `${ref}^{commit}`], {ok: true}); return r.status === 0 ? r.stdout.trim() : null }
  return {name, dir, d, signing: keysFile(home), git: ((args: string[], opt?: GitOpt) => git(dir, args, opt)) as Hub['git'], rev,
    isAncestor: (a, b) => !!a && !!b && git(dir, ['merge-base', '--is-ancestor', a, b], {ok: true}).status === 0,
    main: rev('refs/heads/main') ?? undefined}
}
const room = (H: Hub, name = 'r'): Remote.Room => {
  const ref = `refs/heads/${name}`
  const tip = H.rev(ref) ?? assert.fail('missing room branch')
  const genesis = H.git(['rev-list', '--first-parent', '--reverse', tip, '^refs/heads/main']).trim().split('\n')[0]
  const head = H.git(['log', '-1', '--first-parent', '--format=%H', '--author=^operator ', '--grep=^Kind: room$', tip]).trim() || genesis
  return {name, ref, head, genesis}
}
const tree = (H: Hub, files: Record<string, string> = {}, trees: Record<string, string> = {}) => {
  const entries = Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([p, text]) => `100644 blob ${H.git(['hash-object', '-w', '--stdin'], {input: text}).trim()}\t${p}`)
  for (const [p, sha] of Object.entries(trees)) entries.push(`040000 tree ${sha}\t${p}`)
  return H.git(['mktree'], {input: entries.join('\n') + (entries.length ? '\n' : '')}).trim()
}
const commit = (H: Hub, home: string, who: string, text: string, tr: string, ps: string[], {unsigned = false, signer = who}: {unsigned?: boolean, signer?: string} = {}) => H.git([
  '-c', 'gpg.format=ssh', '-c', 'gpg.ssh.program=ssh-keygen', 'commit-tree',
  ...(!unsigned ? [`-S${path.join(home, 'keys', H.name, signer)}`] : []), tr, ...ps.flatMap(p => ['-p', p]),
], {input: text, env: {GIT_AUTHOR_NAME: who, GIT_AUTHOR_EMAIL: `${who}@fixture`, GIT_COMMITTER_NAME: who, GIT_COMMITTER_EMAIL: `${who}@fixture`}}).trim()
const message = (H: Hub, home: string, who: string, text: string, ps: string[], opt?: {unsigned?: boolean, signer?: string}) => commit(H, home, who, text, ps.length ? H.git(['rev-parse', `${ps[0]}^{tree}`]).trim() : tree(H), ps, opt)
const publish = (H: Hub, ref: string, sha: string, force = false) => H.git(['push', '-q', ...(force ? ['--force'] : []), 'origin', `${sha}:${ref}`])
const tag = (H: Hub, home: string, actor: string, message: string, {signed = true, signer = actor, target = message, signal = 'opened', text, date, name: named}: {
  signed?: boolean, signer?: string, target?: string, signal?: string, text?: string, date?: string, name?: string
} = {}) => {
  const name = named ?? `${actor}.${signal}.${message.slice(0, 12)}`
  const body = text ?? ''
  H.git(['-c', 'gpg.format=ssh', '-c', 'gpg.ssh.program=ssh-keygen', '-c', `user.signingkey=${path.join(home, 'keys', H.name, signer)}`,
    'tag', '-f', signed ? '-s' : '-a', '-F', '-', name, target], {input: body,
    env: {GIT_COMMITTER_NAME: actor, GIT_COMMITTER_EMAIL: `${actor}@fixture`, ...(date ? {GIT_COMMITTER_DATE: date} : {})}})
  const ref = `refs/tags/${name}`
  return {ref, object: H.git(['rev-parse', ref]).trim()}
}
const openTask = (H: Hub, home: string, who: string, subject = 'work'): string => {
  Remote.sync(H)
  const R = room(H), ref = R.ref
  const sha = message(H, home, who, `${subject}\n\nTo: operator\nKind: task\n`, [H.rev(ref) ?? R.genesis])
  H.git(['update-ref', ref, sha])
  Remote.push(H, ref)
  return sha
}
const initBare = (dir: string) => {
  fs.mkdirSync(path.dirname(dir), {recursive: true})
  const r = spawnSync('git', ['init', '--bare', '-q', '-b', 'main', dir], {encoding: 'utf8', env: ENV})
  assert.equal(r.status, 0, r.stderr)
}

const world = (t: TestContext, profile?: string, spec?: Profile) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ringi-remote-'))
  t.after(() => fs.rmSync(base, {recursive: true, force: true}))
  const remote = path.join(base, 'origin.git')
  initBare(remote)
  const url = pathToFileURL(remote).href
  const homes = new Map<string, string>()
  const home = (who: string): string => {
    if (!homes.has(who)) {
      const p = path.join(base, who)
      fs.mkdirSync(p, {recursive: true, mode: 0o700})
      fs.writeFileSync(path.join(p, 'home.json'), '{"version":3}\n')
      homes.set(who, p)
    }
    return homes.get(who)!
  }
  const opHome = home('root')
  initBare(path.join(opHome, 'hub', 'team', 'store', '.git'))
  const op = hub(opHome)
  const setup = Remote.setupSigned(op, url)
  const meta = {schema: 'ringi-hub', version: spec ? '1.1' : '1.0', protocol: 1, capabilities: spec ? ['profiles/1'] : [], trust: 'signed', root: setup.root, ...(profile ? {profile} : {})}
  const mainTree = tree(op, {'contract.json': JSON.stringify(meta), 'HUB.md': '# independent fixture\n'}, spec ? {profiles: tree(op, {[`${spec.name}.json`]: JSON.stringify(spec)})} : {})
  const genesis = commit(op, opHome, 'operator', 'fixture hub\n\nTo: *\nKind: hub\n', mainTree, [])
  op.git(['update-ref', 'refs/heads/main', genesis]); op.main = genesis; op.d.genesis = genesis
  op.git(['remote', 'add', 'origin', url])
  // The operator's descriptor: the store and the pins this machine holds (ringi-hub/2).
  fs.writeFileSync(path.join(opHome, 'hub', 'team', 'hub.json'), JSON.stringify({schema: 'ringi-hub/2', name: 'team', trust: 'signed', root: setup.root, genesis,
    store: {type: 'git', path: 'store', remote: url}}))
  Remote.push(op, 'refs/heads/main')
  const ctlTree = tree(op, {'members.json': '{"operator":{"role":"root"}}', allowed_signers: setup.allowedSigners, 'ROOM.md': '# r\n', ...(spec ? {'profile.json': JSON.stringify(spec)} : {})})
  const ctl = commit(op, opHome, 'operator', `room r\n\nTo: *\nKind: room\nRoom-Id: ${crypto.randomBytes(16).toString('hex')}\n`, ctlTree, [genesis])
  op.git(['update-ref', 'refs/heads/r', ctl])
  Remote.push(op, 'refs/heads/r')
  const replica = (machine: string, {pin = genesis, root = setup.root}: {pin?: string, root?: string} = {}) => {
    const h = home(machine)
    Remote.hubAdd({home: h, name: 'team', url, root, genesis: pin})
    return {H: hub(h), home: h}
  }
  const agent = (who: string, machine = who) => {
    const a = replica(machine)
    const pending = Remote.join(a.H, room(a.H), who)
    assert.equal(pending.admitted, false)
    Remote.roomAdmit(op, room(op), who, pending.publicKey)
    Remote.sync(a.H)
    assert.equal(Remote.join(a.H, room(a.H), who).admitted, true)
    return a
  }
  const run = (machine: string, args: string[], session?: string) => {
    const r = spawnSync(process.execPath, [CLI, ...args], {encoding: 'utf8', env: {...ENV, RINGI_HOME: home(machine), ...(session ? {RINGI_SESSION: session} : {})}})
    return {code: r.status, out: r.stdout, err: r.stderr}
  }
  const ok = (machine: string, args: string[], session?: string) => { const r = run(machine, args, session); assert.equal(r.code, 0, `ringi ${args.join(' ')}: ${r.err}`); return r.out }
  return {base, remote, url, home, op, opHome, meta, genesis, replica, agent, run, ok}
}

// A hub's push alarms as kept in its store; none kept means none.
const pushAlarmsOf = (H: {dir: string}): Record<string, string> => {
  const file = path.join(H.dir, 'ringi', 'push-alarms.json')
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}
}

describe('signed remote hubs', () => {
  describe('bootstrap and admission', () => {
    it('refuses cleartext HTTP before creating a replica', t => {
      const w = world(t)
      for (const url of ['http://example.invalid/ringi.git', 'HTTP://example.invalid/ringi.git']) {
        assert.throws(() => Remote.hubAdd({home: w.home('cleartext'), name: 'unsafe', url, root: w.op.d.root}), /cleartext HTTP/)
        assert.equal(fs.existsSync(path.join(w.home('cleartext'), 'hub', 'unsafe')), false)
      }
    })

    it('requires independent root and genesis pins', t => {
      const w = world(t)
      assert.throws(() => Remote.hubAdd({home: w.home('missing-pin'), name: 'team', url: w.url}), /requires --root/)
      const alienHome = w.home('alien')
      initBare(path.join(alienHome, 'hub', 'alien', 'store', '.git'))
      const alien = hub(alienHome, 'alien')
      const key = Remote.setupSigned(alien).root
      assert.throws(() => w.replica('wrong-pin', {root: key}), /ALARM.*signature/)
      assert.equal(fs.existsSync(path.join(w.home('wrong-pin'), 'hub', 'team')), false)
      assert.throws(() => w.replica('wrong-genesis', {pin: '0'.repeat(40)}), /pinned genesis/)
      const a = w.replica('reader')
      assert.equal(Remote.verifyHub(a.H)!.genesis, w.genesis)
      assert.equal(fs.existsSync(path.join(a.home, 'keys')), false, 'cloning public history must not acquire a root private key')
      assert.throws(() => identityKey(a.H, 'operator'), /no private key.*operator/)
    })

    it('checks admission at the preceding control, without retroactively accepting messages', t => {
      const w = world(t), a = w.replica('bob'), R = room(a.H)
      const key = Remote.join(a.H, R, 'bob')
      assert.equal(key.admitted, false)
      const pending = message(a.H, a.home, 'bob', 'pending\n\nTo: operator\n', [R.genesis])
      publish(a.H, R.ref, pending)
      Remote.sync(w.op)
      assert.equal(w.op.rev(R.ref), pending)
      assert.match(Remote.verify(w.op, room(w.op), 'bob', pending)!, /unadmitted/)
      const admitted = Remote.roomAdmit(w.op, room(w.op), 'bob', key.publicKey)
      Remote.sync(a.H)
      const good = openTask(a.H, a.home, 'bob', 'after admission')
      Remote.sync(w.op)
      const b = Remote.branch(w.op, room(w.op), good)
      assert.match(b.skipped.get(pending)!, /unadmitted/)
      assert.equal(b.authors.get(good), 'bob')
      assert.ok(b.control.includes(admitted))
      assert.equal(Remote.verify(w.op, room(w.op), 'bob', good), null)
    })

    it('uses descriptor pins and URL without trusting git configuration', t => {
      const w = world(t), a = w.replica('reader')
      a.H.git(['config', 'ringi.type', 'local'])
      a.H.git(['config', 'ringi.rootKey', 'untrusted config'])
      a.H.git(['config', 'ringi.genesis', '0'.repeat(40)])
      a.H.git(['config', 'remote.origin.url', pathToFileURL(path.join(w.base, 'missing.git')).href])
      Remote.sync(a.H)
      assert.equal(Remote.verifyHub(a.H)!.genesis, w.genesis)
      delete a.H.d.root
      assert.throws(() => Remote.verifyHub(a.H), /out-of-band root pin/)
      a.H.d.root = w.op.d.root
      delete a.H.d.genesis
      assert.throws(() => Remote.verifyHub(a.H), /no pinned genesis/)
      a.H.d.trust = 'unknown' as Descriptor['trust']
      assert.throws(() => Remote.sync(a.H), /unsupported hub trust/)
    })

    it('refuses an unknown declared room profile instead of applying the default', t => {
      const w = world(t, 'unavailable-1')
      w.ok('root', ['hub', 'switch', 'team'])
      const read = w.run('root', ['log', '--room', 'r'])
      assert.notEqual(read.code, 0)
      assert.match(read.err, /unknown profile unavailable-1/)
    })
  })

  describe('signature verification', () => {
    it('withholds a copied room branch under another name', t => {
      const w = world(t), R = room(w.op)
      const sha = openTask(w.op, w.opHome, 'operator', 'original room work')
      const signal = tag(w.op, w.opHome, 'operator', sha)
      Remote.push(w.op, signal.ref)
      for (const name of ['aaa', 'zzz']) {
        git(w.remote, ['update-ref', `refs/heads/${name}`, sha])
      }
      const added = w.run('reader', ['hub', 'add', 'team', w.url, '--root', w.op.d.root!, '--genesis', w.genesis])
      assert.equal(added.code, 0, added.err)
      assert.match(added.out, /1 room\(s\)/)
      const reader = hub(w.home('reader')), accepted = room(reader)
      Remote.withVerification(reader, () => {
        Remote.verifyRoom(reader, accepted)
        assert.throws(() => Remote.verifyRoom(reader, {...accepted, name: 'zzz'}), /genesis subject.*room zzz/)
      })
      assert.equal(reader.rev(R.ref), sha)
      assert.equal(reader.git(['rev-parse', signal.ref]).trim(), signal.object)
      for (const name of ['aaa', 'zzz']) {
        assert.match(added.err, new RegExp(`ALARM ${name}:.*genesis subject.*room ${name}`))
        assert.equal(reader.rev(`refs/heads/${name}`), null)
        assert.equal(reader.rev(`refs/ringi/remote-accepted/${name}`), null)
        const read = w.run('reader', ['log', '--hub', 'team', '--room', name])
        assert.notEqual(read.code, 0)
        assert.match(read.err, new RegExp(`no room ${name}`))
      }
      const log: ReturnType<typeof asJson>[] = JSON.parse(w.ok('reader', ['log', '--hub', 'team', '--room', 'r', '--all', '--json']))
      assert.equal(log.find(m => m.id === sha)!.trust, 'verified')
    })

    it('skips unsigned and wrong-principal messages while reading valid descendants', t => {
      const w = world(t), bob = w.agent('bob'), alice = w.agent('alice')
      const good = openTask(alice.H, alice.home, 'alice', 'good')
      Remote.sync(bob.H)
      const forged = message(bob.H, bob.home, 'alice', 'forged\n\nTo: bob\n', [good], {signer: 'bob'})
      publish(bob.H, room(bob.H).ref, forged)
      Remote.sync(bob.H)
      assert.match(Remote.verify(bob.H, room(bob.H), 'alice', forged)!, /signature.*alice/)
      assert.equal(Remote.verify(bob.H, room(bob.H), 'alice', good), null)
      const unsigned = message(bob.H, bob.home, 'bob', 'unsigned\n\nTo: bob\n', [forged], {unsigned: true})
      publish(bob.H, room(bob.H).ref, unsigned)
      Remote.sync(bob.H)
      const next = openTask(bob.H, bob.home, 'bob', 'still works')
      Remote.sync(alice.H)
      const b = Remote.branch(alice.H, room(alice.H), next)
      assert.match(b.skipped.get(unsigned)!, /signature/)
      assert.deepEqual([...b.authors.keys()], [good, next])
      assert.equal(alice.H.rev('refs/ringi/remote-accepted/r'), next)
      const store = new GitStore(path.join(alice.home, 'hub', 'team'), alice.H.d, alice.home, alice.H.signing)
      const stored = store.room('r')!
      assert.equal(store.logHead(stored, 'alice'), good)
      assert.deepEqual(store.messages(stored, 'bob', next).map(m => m.id), [next])
      assert.equal(store.alarms(stored).length, 2)
    })

    it('refuses duplicate contract fields and agent-signed control', t => {
      const w = world(t)
      const bob = w.agent('bob')
      const old = room(w.op).head
      const forgedTree = tree(bob.H, {'members.json': '{"operator":{"role":"root"},"mallory":{"role":"member"}}', allowed_signers: bob.H.git(['show', `${old}:allowed_signers`]), 'ROOM.md': '# r\n'})
      const fakeControl = commit(bob.H, bob.home, 'bob', 'admit mallory\n\nTo: *\nKind: room\n', forgedTree, [old])
      publish(bob.H, 'refs/heads/r', fakeControl)
      Remote.sync(w.op)
      assert.match(Remote.branch(w.op, room(w.op), fakeControl).skipped.get(fakeControl)!, /control files/)
      assert.ok(!Remote.verifyRoom(w.op, room(w.op)).members.mallory)
      const tr = tree(w.op, {'contract.json': JSON.stringify(w.meta).replace(/}$/, ',"trust":"asserted"}')})
      const bad = commit(w.op, w.opHome, 'operator', 'ambiguous contract\n\nTo: *\nKind: hub\n', tr, [w.genesis])
      publish(w.op, 'refs/heads/main', bad)
      assert.throws(() => Remote.sync(w.op), /ALARM.*duplicate JSON/)
      assert.equal(w.op.rev('refs/heads/main'), w.genesis)
    })

    it('does not let delimiters in a skipped commit impersonate verified controls or messages', t => {
      const w = world(t), bob = w.agent('bob'), victim = openTask(w.op, w.opHome, 'operator', 'authentic task')
      Remote.sync(bob.H)
      const R = room(bob.H), parent = bob.H.git(['show', '-s', '--format=%P', victim]).trim()
      const injection = `bad\n\nTo: operator\n\x1e${R.genesis}\x1f${w.genesis}\x1foperator\x1fFORGED control\n\nTo: *\nKind: room\n\x1e` +
        `${victim}\x1f${parent}\x1f1\x1foperator\x1fFORGED task\n\nTo: bob\nKind: task\n\x1f\n`
      const bad = message(bob.H, bob.home, 'bob', injection, [victim])
      publish(bob.H, R.ref, bad)
      const next = openTask(w.op, w.opHome, 'operator', 'authentic descendant')
      const store = new GitStore(path.join(w.opHome, 'hub', 'team'), w.op.d, w.opHome, w.op.signing), stored = store.room('r')!
      assert.ok(stored.control.every(c => !c.text.includes('FORGED')), 'only real Git objects supply control records')
      assert.equal(new Set(stored.control.map(c => c.rev)).size, stored.control.length)
      const messages = store.messages(stored, 'operator', next)
      assert.deepEqual(messages.map(m => m.id), [victim, next])
      assert.ok(messages.every(m => !m.text.toString().includes('FORGED')), 'skipped bytes cannot borrow an authenticated message id')
      assert.match(store.alarms(stored)[0], /control characters/)
    })

    it('quarantines root-signed malformed rosters and refuses to launder agent control changes through admission', t => {
      const w = world(t), bob = w.agent('bob'), R = room(w.op), old = w.op.rev(R.ref)!
      const allowed = w.op.git(['show', `${old}:allowed_signers`])
      for (const [members, signers, why] of [
        ['{"operator":{"role":"root"}}', Remote.rootRoster(w.op), /drops or changes/],
        ['{"operator":{"role":"root"},"operator":{"role":"root"}}', allowed, /duplicate JSON/],
      ] as const) {
        const tr = tree(w.op, {'members.json': members, allowed_signers: signers, 'ROOM.md': '# r\n'})
        const bad = commit(w.op, w.opHome, 'operator', 'bad roster\n\nTo: *\nKind: room\n', tr, [old])
        publish(w.op, R.ref, bad, true)
        Remote.sync(w.op)
        assert.match(w.op.remoteAlarms?.[R.ref] ?? '', why)
        assert.equal(w.op.rev(R.ref), old)
        assert.equal(w.op.rev('refs/ringi/remote-accepted/r'), old)
        publish(w.op, R.ref, old, true)
        Remote.sync(w.op)
      }
      const poisoned = tree(bob.H, {'members.json': '{"operator":{"role":"root"},"mallory":{"role":"member"}}', allowed_signers: allowed, 'ROOM.md': '# poisoned\n'})
      const bad = commit(bob.H, bob.home, 'bob', 'poison control files\n\nTo: operator\n', poisoned, [old])
      publish(bob.H, R.ref, bad)
      Remote.sync(w.op)
      const alice = w.replica('alice'), key = Remote.join(alice.H, room(alice.H), 'alice').publicKey
      const fixed = Remote.roomAdmit(w.op, room(w.op), 'alice', key)
      const verified = Remote.branch(w.op, room(w.op), fixed)
      assert.match(verified.skipped.get(bad)!, /control files/)
      assert.deepEqual(Object.keys(verified.members).sort(), ['alice', 'bob', 'operator'])
      assert.equal(w.op.git(['show', `${fixed}:ROOM.md`]), '# r\n')
    })

    it('refuses replay into another room', t => {
      const w = world(t)
      const bob = w.agent('bob')
      const original = room(bob.H)
      const ctlTree = w.op.git(['rev-parse', `${room(w.op).head}^{tree}`]).trim()
      const other = commit(w.op, w.opHome, 'operator', `room other\n\nTo: *\nKind: room\nRoom-Id: ${crypto.randomBytes(16).toString('hex')}\n`, ctlTree, [w.genesis])
      w.op.git(['update-ref', 'refs/heads/other', other])
      Remote.push(w.op, 'refs/heads/other')
      const sha = message(bob.H, bob.home, 'bob', 'belongs to r\n\nTo: operator\n', [bob.H.rev(original.ref)!])
      publish(bob.H, 'refs/heads/other', sha, true)
      Remote.sync(w.op)
      assert.match(w.op.remoteAlarms?.['refs/heads/other'] ?? '', /genesis/)
      assert.equal(w.op.rev('refs/heads/other'), other)
    })
  })

  describe('Git command limits', () => {
    it('applies finite defaults and overrides to all Git paths, refusing invalid values before spawn', t => {
      const w = world(t), store = new GitStore(path.join(w.opHome, 'hub', 'team'), w.op.d, w.opHome, w.op.signing)
      const before = process.env.RINGI_GIT_TIMEOUT_MS, original = childProcess.spawnSync, limits: number[] = []
      const mock = t.mock.method(childProcess, 'spawnSync', (cmd: string, args: readonly string[], opt: SpawnSyncOptions) => {
        if (cmd === 'git') limits.push(opt.timeout!)
        return original(cmd, args, opt)
      })
      syncBuiltinESMExports()
      try {
        for (const value of [undefined, '12345']) {
          if (value === undefined) delete process.env.RINGI_GIT_TIMEOUT_MS
          else process.env.RINGI_GIT_TIMEOUT_MS = value
          limits.length = 0
          assert.equal(Remote.verifyHub(w.op)!.genesis, w.genesis)
          assert.match(runGit(['--version']), /git version/)
          assert.equal(store.contractFile(w.genesis, 'contract.json'), JSON.stringify(w.meta))
          assert.equal(store.file(w.genesis, 'contract.json').toString(), JSON.stringify(w.meta))
          assert.ok(limits.length > 3)
          assert.ok(limits.every(ms => ms === (value ? 12345 : 30000)), JSON.stringify(limits))
        }
        for (const value of ['', '0', '-1', '1.5', 'NaN', 'Infinity', '9007199254740992']) {
          process.env.RINGI_GIT_TIMEOUT_MS = value
          const count = limits.length
          assert.throws(() => Remote.verifyHub(w.op), /RINGI_GIT_TIMEOUT_MS must be a positive integer/, value)
          assert.throws(() => runGit(['--version']), /RINGI_GIT_TIMEOUT_MS must be a positive integer/, value)
          assert.equal(limits.length, count, 'invalid limits must not start Git')
        }
      } finally {
        if (before === undefined) delete process.env.RINGI_GIT_TIMEOUT_MS
        else process.env.RINGI_GIT_TIMEOUT_MS = before
        mock.mock.restore(); syncBuiltinESMExports()
      }
    })

    it('names the timeout setting even when Git probes ordinarily allow failure', t => {
      const w = world(t), store = new GitStore(path.join(w.opHome, 'hub', 'team'), w.op.d, w.opHome, w.op.signing)
      const error = Object.assign(new Error('spawnSync git ETIMEDOUT'), {code: 'ETIMEDOUT'})
      const mock = t.mock.method(childProcess, 'spawnSync', () => ({error, status: null, signal: 'SIGTERM', stdout: '', stderr: ''}))
      syncBuiltinESMExports()
      try {
        for (const invoke of [() => Remote.verifyHub(w.op), () => runGit(['--version']),
          () => store.contractFile(w.genesis, 'contract.json'), () => store.file(w.genesis, 'contract.json')]) {
          assert.throws(invoke, {code: 'ETIMEDOUT', message: /git timed out.*RINGI_GIT_TIMEOUT_MS/})
        }
      } finally { mock.mock.restore(); syncBuiltinESMExports() }
    })
  })

  describe('replication and recovery', () => {
    it('refuses corrupt push alarm state before publishing', t => {
      const w = world(t), sha = openTask(w.op, w.opHome, 'operator'), s = tag(w.op, w.opHome, 'operator', sha)
      const file = path.join(w.op.dir, 'ringi', 'push-alarms.json')
      const malformed = ['', 'null', '[]', '{"a":1}', '{"a":"first","a":"second"}']
      for (const text of malformed) {
        fs.writeFileSync(file, text)
        assert.throws(() => Remote.sync(w.op), /push-alarms\.json/)
        assert.throws(() => Remote.push(w.op, s.ref), /push-alarms\.json/)
        assert.equal(fs.readFileSync(file, 'utf8'), text)
        assert.equal(git(w.remote, ['rev-parse', '-q', '--verify', s.ref], {ok: true}).status, 1)
      }
    })

    it('alarms on rewrites, rollbacks and deletions until restoration', t => {
      const w = world(t)
      const bob = w.agent('bob')
      const first = message(bob.H, bob.home, 'bob', 'first\n\nTo: operator\n', [bob.H.rev(room(bob.H).ref)!])
      const second = message(bob.H, bob.home, 'bob', 'second\n\nTo: operator\n', [first])
      publish(bob.H, 'refs/heads/r', second)
      Remote.sync(w.op)
      const rewritten = message(bob.H, bob.home, 'bob', 'rewritten\n\nTo: operator\n', [first])
      publish(bob.H, 'refs/heads/r', rewritten, true)
      Remote.sync(w.op)
      assert.match(w.op.remoteAlarms?.['refs/heads/r'] ?? '', /rewritten|rolled back/)
      assert.equal(w.op.rev('refs/heads/r'), second)
      publish(bob.H, 'refs/heads/r', first, true)
      Remote.sync(w.op)
      assert.match(w.op.remoteAlarms?.['refs/heads/r'] ?? '', /rolled back/)
      publish(bob.H, 'refs/heads/r', second, true)
      Remote.sync(w.op)
      assert.equal(w.op.remoteAlarms?.['refs/heads/r'], undefined)
      bob.H.git(['push', '-q', 'origin', ':refs/heads/r'])
      Remote.sync(w.op)
      assert.match(w.op.remoteAlarms?.['refs/heads/r'] ?? '', /deleted/)
      assert.equal(w.op.rev('refs/heads/r'), second)
    })

    it('refuses merges and retains rejected publications', t => {
      const w = world(t)
      const bob = w.agent('bob')
      const R = room(bob.H)
      const first = message(bob.H, bob.home, 'bob', 'first\n\nTo: operator\n', [bob.H.rev(R.ref)!])
      publish(bob.H, R.ref, first)
      Remote.sync(w.op); Remote.sync(bob.H)
      const merge = message(bob.H, bob.home, 'bob', 'merge\n\nTo: operator\n', [first, R.genesis])
      publish(bob.H, R.ref, merge)
      Remote.sync(w.op)
      assert.match(w.op.remoteAlarms?.[R.ref] ?? '', /linear/)
      publish(bob.H, R.ref, first, true)
      const theirs = message(bob.H, bob.home, 'bob', 'theirs\n\nTo: operator\n', [first])
      const ours = message(bob.H, bob.home, 'bob', 'ours\n\nTo: operator\n', [first])
      publish(bob.H, R.ref, theirs)
      bob.H.git(['update-ref', R.ref, ours])
      assert.throws(() => Remote.push(bob.H, R.ref), /ALARM.*push rejected/)
      assert.equal(bob.H.rev(R.ref), ours)
      assert.equal(git(w.remote, ['rev-parse', R.ref]).trim(), theirs)
      Remote.sync(bob.H)
      assert.match(bob.H.remoteAlarms?.[R.ref] ?? '', /push rejected|diverges/)
      const file = path.join(bob.H.dir, 'ringi', 'push-alarms.json')
      assert.match(JSON.parse(fs.readFileSync(file, 'utf8'))[R.ref], /push rejected/)
      publish(bob.H, R.ref, ours, true)
      Remote.push(bob.H, R.ref)
      Remote.sync(bob.H)
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {})
      assert.deepEqual(bob.H.remoteAlarms, {})
    })

    it('retains evidence and skips invalid messages after explicit baseline acceptance', t => {
      const w = world(t), bob = w.agent('bob'), R = room(bob.H), base = bob.H.rev('refs/heads/r')!
      const first = message(bob.H, bob.home, 'bob', 'first\n\nTo: operator\n', [base])
      publish(bob.H, R.ref, first)
      Remote.sync(w.op)
      const replacement = message(bob.H, bob.home, 'bob', 'replacement\n\nTo: operator\n', [base])
      publish(bob.H, R.ref, replacement, true)
      Remote.sync(w.op)
      assert.match(w.op.remoteAlarms?.[R.ref] ?? '', /rewritten/)
      Remote.forget(w.op, room(w.op))
      Remote.sync(w.op)
      assert.equal(w.op.rev(R.ref), replacement)
      assert.equal(w.op.rev(`refs/ringi/quarantine/${R.genesis}/${first}`), first)
      const unsigned = message(bob.H, bob.home, 'bob', 'unsigned\n\nTo: operator\n', [base], {unsigned: true})
      publish(bob.H, R.ref, unsigned, true)
      Remote.sync(w.op)
      Remote.forget(w.op, room(w.op))
      Remote.sync(w.op)
      assert.match(Remote.branch(w.op, room(w.op), unsigned).skipped.get(unsigned)!, /signature/)
      assert.notEqual(Remote.verify(w.op, room(w.op), 'bob', unsigned), null)
    })
  })


  describe('signed signal tags', () => {
    it('refreshes authors after the branch tip or alarms change within one verification scope', t => {
      const w = world(t), bob = w.agent('bob'), R = room(bob.H)
      const first = openTask(bob.H, bob.home, 'bob'), opened = tag(bob.H, bob.home, 'bob', first)
      Remote.withVerification(bob.H, () => {
        assert.equal(Remote.verifySignal(bob.H, R, opened.ref, opened.object), null)
        const second = openTask(bob.H, bob.home, 'bob', 'next task'), next = tag(bob.H, bob.home, 'bob', second)
        Remote.push(bob.H, next.ref)
        assert.equal(Remote.verifySignal(bob.H, R, next.ref, next.object), null)
        bob.H.remoteAlarms ??= {}
        bob.H.remoteAlarms[R.ref] = 'test quarantine'
        assert.match(Remote.verifySignal(bob.H, R, opened.ref, opened.object)!, /quarantined/)
        delete bob.H.remoteAlarms[R.ref]
        assert.equal(Remote.verifySignal(bob.H, R, opened.ref, opened.object), null)
      })
    })

    it('publishes and pins the annotated object signed by its actor', t => {
      const w = world(t), bob = w.agent('bob')
      const sha = openTask(bob.H, bob.home, 'bob')
      const unrelated = message(bob.H, bob.home, 'bob', 'invalid unrelated control', [w.genesis])
      bob.H.git(['update-ref', 'refs/heads/aaa', unrelated])
      const s = tag(bob.H, bob.home, 'bob', sha)
      Remote.push(bob.H, s.ref)
      Remote.sync(w.op)
      assert.equal(w.op.git(['rev-parse', s.ref]).trim(), s.object)
      assert.notEqual(s.object, sha)
      assert.equal(w.op.rev(s.ref), sha)
      assert.equal(w.op.git(['rev-parse', s.ref.replace('refs/tags/', 'refs/ringi/remote-accepted-tags/')]).trim(), s.object)
      assert.equal(Remote.verifySignal(w.op, room(w.op), s.ref, s.object), null)
      assert.equal(s.ref, `refs/tags/bob.opened.${sha.slice(0, 12)}`)
      const raw = bob.H.git(['cat-file', 'tag', s.object])
      assert.match(raw, new RegExp(`^object ${sha}\\ntype commit\\ntag bob\\.opened\\.${sha.slice(0, 12)}\\ntagger bob `))
      assert.equal(raw.split('\n\n').slice(1).join('\n\n').split('-----BEGIN SSH SIGNATURE-----')[0], '')
    })

    it('ignores tags that are no signals, and refuses them on explicit signal pushes', t => {
      const w = world(t), bob = w.agent('bob')
      const sha = openTask(bob.H, bob.home, 'bob'), R = room(bob.H)
      for (const name of [`ringi/${R.genesis}/bob/${sha}.opened`, `ringi/bob/${sha.slice(0, 12)}.opened`, `bob.opened.${sha}`, 'release-v1']) {
        const s = tag(bob.H, bob.home, 'bob', sha, {name})
        assert.throws(() => Remote.push(bob.H, s.ref), /malformed signal tag namespace/)
        publish(bob.H, s.ref, s.object)
      }
      const valid = tag(bob.H, bob.home, 'bob', sha, {signal: 'state.completed'})
      Remote.push(bob.H, valid.ref)
      Remote.sync(w.op)
      assert.deepEqual(w.op.remoteAlarms, {})
      assert.deepEqual(w.op.git(['for-each-ref', '--format=%(refname)', 'refs/tags/']).trim().split('\n'), [valid.ref])
      assert.equal(Remote.verifySignal(w.op, room(w.op), valid.ref, valid.object), null)
    })

    it('withholds unsigned, lightweight, wrong-principal and mismatched tags', t => {
      const w = world(t), bob = w.agent('bob'), alice = w.agent('alice')
      Remote.sync(bob.H)
      for (const [kind, why] of [
        ['unsigned', /bad or missing signature/],
        ['lightweight', /must be an annotated tag/],
        ['wrong-principal', /bad or missing signature/],
        ['body', /message must be empty/],
        ['target', /name, actor or target disagrees/],
      ] as const) {
        const previous = bob.H.rev(room(bob.H).ref) ?? room(bob.H).genesis
        const sha = openTask(bob.H, bob.home, 'bob', kind)
        const s = tag(bob.H, kind === 'wrong-principal' ? alice.home : bob.home, 'bob', sha, {
          signed: kind !== 'unsigned', signer: kind === 'wrong-principal' ? 'alice' : 'bob',
          ...(kind === 'body' ? {text: 'opened\n\nActor: alice\n'} : {}),
          ...(kind === 'target' ? {target: previous} : {}),
        })
        if (kind === 'lightweight') bob.H.git(['update-ref', s.ref, sha])
        const raw = bob.H.git(['rev-parse', s.ref]).trim()
        publish(bob.H, s.ref, raw)
        Remote.sync(w.op)
        assert.match(w.op.remoteAlarms?.[s.ref] ?? '', why, kind)
        assert.equal(w.op.git(['rev-parse', '-q', '--verify', s.ref], {ok: true}).status, 1, kind)
      }
    })

    it('alarms on tag replacement and deletion until the accepted object is restored', t => {
      const w = world(t), bob = w.agent('bob')
      const sha = openTask(bob.H, bob.home, 'bob')
      const first = tag(bob.H, bob.home, 'bob', sha, {date: '2026-10-11T00:00:00Z'})
      Remote.push(bob.H, first.ref)
      Remote.sync(w.op)
      const changed = tag(bob.H, bob.home, 'bob', sha, {date: '2026-10-11T00:00:01Z'})
      assert.notEqual(changed.object, first.object)
      assert.throws(() => Remote.push(bob.H, first.ref), /accepted transport history/)
      publish(bob.H, changed.ref, changed.object, true)
      Remote.sync(w.op)
      assert.match(w.op.remoteAlarms?.[first.ref] ?? '', /replaced/)
      assert.equal(w.op.git(['rev-parse', first.ref]).trim(), first.object)
      assert.match(Remote.verifySignal(w.op, room(w.op), first.ref, first.object)!, /replaced/)
      bob.H.git(['push', '-q', 'origin', `:${first.ref}`])
      Remote.sync(w.op)
      assert.match(w.op.remoteAlarms?.[first.ref] ?? '', /deleted/)
      assert.equal(w.op.git(['rev-parse', first.ref]).trim(), first.object)
      publish(bob.H, first.ref, first.object)
      Remote.sync(w.op)
      assert.equal(w.op.remoteAlarms?.[first.ref], undefined)
      assert.equal(Remote.verifySignal(w.op, room(w.op), first.ref, first.object), null)
    })

    it('alarms for ordinary readers when a signed tag claims an unauthorized transition', t => {
      const w = world(t), bob = w.agent('bob')
      const task = openTask(bob.H, bob.home, 'bob')
      const R = room(bob.H)
      const reply = message(bob.H, bob.home, 'bob', `unauthorized completion\n\nTo: operator\nRe: ${task}\nState: completed\n`, [task])
      bob.H.git(['update-ref', R.ref, reply])
      Remote.push(bob.H, R.ref)
      const s = tag(bob.H, bob.home, 'bob', reply, {signal: 'state.completed'})
      publish(bob.H, s.ref, s.object)
      w.ok('root', ['hub', 'switch', 'team'])
      const read = w.run('root', ['log', '--room', 'r', '--json'])
      assert.equal(read.code, 0, read.err)
      assert.match(read.err, /ALARM signal.*did not make state.completed/)
      const tasks = JSON.parse(w.ok('root', ['tasks', '--room', 'r', '--all', '--json']))
      assert.equal(tasks[0].state, 'submitted')
    })
  })

  describe('signed coordination marks', () => {
    it('walks each chain once when syncing many read marks', t => {
      const w = world(t), bob = w.agent('bob'), alice = w.agent('alice')
      const R = room(bob.H), messages: string[] = []
      Remote.sync(bob.H)
      let head = bob.H.rev(R.ref)!
      for (let i = 0; i < 12; i++) {
        head = message(bob.H, bob.home, 'bob', `message ${i}\n\nTo: alice\n`, [head])
        messages.push(head)
      }
      bob.H.git(['update-ref', R.ref, head])
      Remote.push(bob.H, R.ref)
      Remote.sync(alice.H)
      const publishMarks = (ids: string[]) => {
        const marks = ids.map(id => tag(alice.H, alice.home, 'alice', id, {signal: 'read'}))
        alice.H.git(['push', '-q', 'origin', ...marks.map(s => `${s.object}:${s.ref}`)])
      }
      const count = () => {
        const original = childProcess.spawnSync, calls: string[][] = []
        const mock = t.mock.method(childProcess, 'spawnSync', (cmd: string, args: readonly string[], opt: SpawnSyncOptions) => {
          if (cmd === 'git') calls.push([...args])
          return original(cmd, args, opt)
        })
        syncBuiltinESMExports()
        try { Remote.sync(w.op) } finally { mock.mock.restore(); syncBuiltinESMExports() }
        return {calls: calls.length, walks: calls.filter(args => args.includes('rev-list')).length}
      }
      publishMarks(messages.slice(0, 1))
      const one = count()
      publishMarks(messages.slice(1))
      const many = count()
      assert.ok(one.walks <= 3 && many.walks <= 3, JSON.stringify({one, many}))
      assert.ok(many.calls <= one.calls + 16 * (messages.length - 1), JSON.stringify({one, many}))
      assert.deepEqual(w.op.remoteAlarms, {})
      t.diagnostic(`sync with 1 and 12 read marks: ${JSON.stringify({one, many})}`)
    })

    it('replicates a member\'s read and taken marks on another author\'s accepted message', t => {
      const w = world(t), bob = w.agent('bob'), alice = w.agent('alice')
      Remote.sync(bob.H)
      const R = room(bob.H), ref = R.ref
      const sha = message(bob.H, bob.home, 'bob', 'work for alice\n\nTo: alice\nKind: task\n', [bob.H.rev(R.ref)!])
      bob.H.git(['update-ref', ref, sha])
      Remote.push(bob.H, ref)
      Remote.sync(alice.H)
      assert.ok(![...Remote.branch(alice.H, R, sha).authors.values()].includes('alice'), 'a member need not have authored a message to mark one')
      for (const signal of ['read', 'taken']) {
        const s = tag(alice.H, alice.home, 'alice', sha, {signal})
        Remote.push(alice.H, s.ref)
        Remote.sync(w.op)
        assert.equal(w.op.git(['rev-parse', s.ref]).trim(), s.object)
        assert.equal(Remote.verifySignal(w.op, room(w.op), s.ref, s.object), null)
      }
      w.ok('root', ['hub', 'switch', 'team'])
      const checked: Array<{signal: string, actor: string, ok: boolean}> = JSON.parse(w.ok('root', ['signals', '--room', 'r', '--all', '--json']))
      assert.equal(checked.filter(s => s.actor === 'alice' && ['read', 'taken'].includes(s.signal) && s.ok).length, 2)
      const tasks = JSON.parse(w.ok('root', ['tasks', '--room', 'r', '--all', '--json']))
      assert.equal(tasks[0].state, 'submitted', 'marks carry no task authority')
      assert.deepEqual(tasks[0].assignees, ['alice'])
    })

    it('rejects wrong signers and foreign targets, and skips invalid targets while retaining valid marks', t => {
      const w = world(t), bob = w.agent('bob'), alice = w.agent('alice')
      const sha = openTask(bob.H, bob.home, 'bob')
      const ctlTree = w.op.git(['rev-parse', `${room(w.op).head}^{tree}`]).trim()
      const other = commit(w.op, w.opHome, 'operator', 'room other\n\nTo: *\nKind: room\n', ctlTree, [w.genesis])
      w.op.git(['update-ref', 'refs/heads/other', other])
      Remote.push(w.op, 'refs/heads/other')
      const foreign = message(w.op, w.opHome, 'operator', 'foreign work\n\nTo: alice\nKind: task\n', [other])
      w.op.git(['update-ref', 'refs/heads/other', foreign])
      Remote.push(w.op, 'refs/heads/other')
      Remote.sync(alice.H)
      for (const [target, signal, signer, home, why] of [
        [sha, 'read', 'bob', bob.home, /bad or missing signature/],
        [w.genesis, 'read', 'alice', alice.home, /no verified room/],
        [room(alice.H).genesis, 'taken', 'alice', alice.home, /no message of this room/],
        [sha, 'opened', 'alice', alice.home, /no accepted message of its actor/],
        [sha, 'usage.reserve', 'alice', alice.home, /no accepted message of its actor/],
        [sha, 'usage.settle', 'alice', alice.home, /no accepted message of its actor/],
      ] as const) {
        const s = tag(alice.H, home, 'alice', target, {signal, signer})
        assert.throws(() => Remote.push(alice.H, s.ref), why)
      }
      const foreignMark = tag(alice.H, alice.home, 'alice', foreign, {signal: 'taken'})
      assert.equal(Remote.push(alice.H, foreignMark.ref), true, 'the full target identifies its other admitted room')
      assert.match(Remote.verifySignal(alice.H, room(alice.H), foreignMark.ref, foreignMark.object)!, /no accepted message of this room/)
      const R = room(bob.H)
      const unsigned = message(bob.H, bob.home, 'bob', 'bad extension\n\nTo: alice\n', [sha], {unsigned: true})
      publish(bob.H, R.ref, unsigned)
      Remote.sync(alice.H)
      const s = tag(alice.H, alice.home, 'alice', sha, {signal: 'taken'})
      assert.equal(Remote.push(alice.H, s.ref), true, 'an invalid descendant does not quarantine a valid ancestor')
      const bad = tag(alice.H, alice.home, 'alice', unsigned, {signal: 'taken'})
      assert.throws(() => Remote.push(alice.H, bad.ref), /no accepted message/)
    })
  })

  describe('one shared branch', () => {
    const store = (a: {H: Hub, home: string}) => new GitStore(path.join(a.home, 'hub', 'team'), a.H.d, a.home, a.H.signing)

    it('retries a stale replica and returns published message ids with both attachments and signals intact', t => {
      const w = world(t), bob = w.agent('bob'), alice = w.agent('alice')
      Remote.sync(bob.H)
      const b = store(bob), a = store(alice), br = b.room('r')!, ar = a.room('r')!
      assert.equal(br.tip, ar.tip)
      const task = b.append(br, 'bob', 'work\n\nTo: alice\nKind: task\nAssign: alice\n', [{path: 'bob.txt', content: 'from bob', mode: '100644'}])
      const reply = a.append(ar, 'alice', `done\n\nTo: bob\nRe: ${task}\nState: completed\n`, [{path: 'alice.txt', content: 'from alice', mode: '100644'}])
      assert.equal(git(w.remote, ['rev-parse', 'refs/heads/r']).trim(), reply)
      assert.equal(alice.H.git(['show', '-s', '--format=%P', reply]).trim(), task)
      assert.equal(a.file(reply, 'bob.txt').toString(), 'from bob')
      assert.equal(a.file(reply, 'alice.txt').toString(), 'from alice')
      assert.match(alice.H.git(['show', '-s', '--format=%B', reply]), new RegExp(`Re: ${task}`))
      const evidence = alice.H.git(['for-each-ref', '--format=%(objectname)', 'refs/ringi/unpublished/']).trim()
      assert.ok(evidence && evidence !== reply, 'the unreturned, unpublished id is retained as evidence')
      assert.ok(!alice.H.isAncestor(evidence, reply))
      const completion = tag(alice.H, alice.home, 'alice', reply, {signal: 'state.completed'})
      Remote.push(alice.H, completion.ref)
      const mark = tag(alice.H, alice.home, 'alice', task, {signal: 'read'})
      Remote.push(alice.H, mark.ref)
      Remote.sync(w.op)
      assert.equal(Remote.verifySignal(w.op, room(w.op), completion.ref, completion.object), null)
      assert.equal(Remote.verifySignal(w.op, room(w.op), mark.ref, mark.object), null)
      assert.deepEqual(git(w.remote, ['for-each-ref', '--format=%(refname)', 'refs/heads/']).trim().split('\n'), ['refs/heads/main', 'refs/heads/r'])
      assert.deepEqual(alice.H.remoteAlarms ?? {}, {})
    })

    it('recomputes admission after concurrent root writes without losing either member', t => {
      const w = world(t), pendingBob = w.replica('bob'), pendingAlice = w.replica('alice')
      const bobKey = Remote.join(pendingBob.H, room(pendingBob.H), 'bob').publicKey
      const aliceKey = Remote.join(pendingAlice.H, room(pendingAlice.H), 'alice').publicKey
      const secondRoot = w.replica('root-two')
      const keyDir = path.join(secondRoot.home, 'keys', 'team')
      fs.mkdirSync(keyDir, {recursive: true})
      fs.copyFileSync(path.join(w.opHome, 'keys', 'team', 'operator'), path.join(keyDir, 'operator'))
      fs.copyFileSync(path.join(w.opHome, 'keys', 'team', 'operator.pub'), path.join(keyDir, 'operator.pub'))
      const first = Remote.roomAdmit(w.op, room(w.op), 'bob', bobKey)
      const second = Remote.roomAdmit(secondRoot.H, room(secondRoot.H), 'alice', aliceKey)
      assert.equal(secondRoot.H.git(['show', '-s', '--format=%P', second]).trim(), first)
      Remote.sync(pendingBob.H); Remote.sync(pendingAlice.H)
      const members = Remote.verifyRoom(pendingBob.H, room(pendingBob.H)).members
      assert.deepEqual(Object.keys(members).sort(), ['alice', 'bob', 'operator'])
      assert.equal(Remote.join(pendingBob.H, room(pendingBob.H), 'bob').admitted, true)
      assert.equal(Remote.join(pendingAlice.H, room(pendingAlice.H), 'alice').admitted, true)
    })

    it('recognizes a lost push acknowledgement without changing the published id', t => {
      const w = world(t), bob = w.agent('bob'), b = store(bob), R = b.room('r')!
      const original = childProcess.spawnSync
      let intercepted = false
      const mock = t.mock.method(childProcess, 'spawnSync', (cmd: string, args: readonly string[], opt: SpawnSyncOptions) => {
        const result = original(cmd, args, opt)
        if (!intercepted && cmd === 'git' && args.includes('push') && args.includes('--porcelain')) {
          intercepted = true
          assert.equal(result.status, 0)
          return {...result, status: 1, stderr: 'acknowledgement lost after publication'}
        }
        return result
      })
      syncBuiltinESMExports()
      let sha: string
      try { sha = b.append(R, 'bob', 'published once\n\nTo: operator\n', []) }
      finally { mock.mock.restore(); syncBuiltinESMExports() }
      assert.ok(intercepted)
      assert.equal(git(w.remote, ['rev-parse', 'refs/heads/r']).trim(), sha)
      assert.equal(bob.H.git(['for-each-ref', '--format=%(refname)', 'refs/ringi/unpublished/']).trim(), '')
      assert.deepEqual(pushAlarmsOf(bob.H), {})
    })

    it('refuses automatic retry onto a rollback and retains the unreturned local commit', t => {
      const w = world(t), bob = w.agent('bob'), b = store(bob), R = b.room('r')!
      const accepted = bob.H.rev('refs/ringi/remote-accepted/r')!, original = childProcess.spawnSync
      let intercepted = false
      const mock = t.mock.method(childProcess, 'spawnSync', (cmd: string, args: readonly string[], opt: SpawnSyncOptions) => {
        if (!intercepted && cmd === 'git' && args.includes('push') && args.includes('--porcelain')) {
          intercepted = true
          git(w.remote, ['update-ref', 'refs/heads/r', R.genesis])
          return {status: 1, signal: null, error: undefined, pid: 0, output: [], stdout: '!\trefs/heads/r\t[rejected] (non-fast-forward)', stderr: ''}
        }
        return original(cmd, args, opt)
      })
      syncBuiltinESMExports()
      try { assert.throws(() => b.append(R, 'bob', 'must not retry\n\nTo: operator\n', []), /ALARM.*rolled back/) }
      finally { mock.mock.restore(); syncBuiltinESMExports() }
      const local = bob.H.rev('refs/heads/r')!
      assert.ok(local !== accepted && bob.H.isAncestor(accepted, local))
      assert.equal(bob.H.rev('refs/ringi/remote-accepted/r'), accepted)
      assert.equal(git(w.remote, ['rev-parse', 'refs/heads/r']).trim(), R.genesis)
      assert.match(JSON.parse(fs.readFileSync(path.join(bob.H.dir, 'ringi', 'push-alarms.json'), 'utf8'))['refs/heads/r'], /rolled back/)
    })

    it('retains multiple pending local commits instead of automatically rewriting their ids', t => {
      const w = world(t), bob = w.agent('bob'), alice = w.agent('alice')
      Remote.sync(bob.H)
      const R = room(bob.H), base = bob.H.rev(R.ref)!
      const first = message(bob.H, bob.home, 'bob', 'pending one\n\nTo: operator\n', [base])
      const second = message(bob.H, bob.home, 'bob', 'pending two\n\nTo: operator\n', [first])
      bob.H.git(['update-ref', R.ref, second])
      const theirs = openTask(alice.H, alice.home, 'alice', 'published first')
      assert.throws(() => Remote.push(bob.H, R.ref, {behind: true}), /ALARM.*push rejected/)
      assert.equal(bob.H.rev(R.ref), second)
      assert.equal(bob.H.rev('refs/ringi/remote-accepted/r'), base)
      assert.equal(git(w.remote, ['rev-parse', R.ref]).trim(), theirs)
      assert.equal(bob.H.git(['for-each-ref', '--format=%(refname)', 'refs/ringi/unpublished/']).trim(), '')
    })

    it('rejects a merge that hides accepted first-parent messages behind its second parent', t => {
      const w = world(t), bob = w.agent('bob'), R = room(bob.H), base = bob.H.rev(R.ref)!
      const accepted = openTask(bob.H, bob.home, 'bob', 'accepted')
      Remote.sync(w.op)
      const fork = message(bob.H, bob.home, 'bob', 'fork\n\nTo: operator\n', [base])
      const merge = message(bob.H, bob.home, 'bob', 'hide accepted\n\nTo: operator\n', [fork, accepted])
      assert.ok(bob.H.isAncestor(accepted, merge))
      publish(bob.H, R.ref, merge)
      Remote.sync(w.op)
      assert.match(w.op.remoteAlarms?.[R.ref] ?? '', /merge.*linear/)
      assert.equal(w.op.rev(R.ref), accepted)
      assert.equal(w.op.rev('refs/ringi/remote-accepted/r'), accepted)
    })
  })

  describe('transport contention', () => {
    it('waits for a live transport owner beyond five seconds', async t => {
      const w = world(t)
      const lock = path.join(w.op.dir, 'ringi', 'transport.lock')
      const ready = path.join(w.base, 'ready'), released = path.join(w.base, 'released')
      const util = pathToFileURL(path.join(HERE, '../../main/ts/adapters/fs/index.ts')).href
      const holder = spawn(process.execPath, ['--input-type=module', '-e', `
        import fs from 'node:fs';
        import {locked} from ${JSON.stringify(util)};
        locked(${JSON.stringify(lock)}, () => {
          fs.writeFileSync(${JSON.stringify(ready)}, '');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6500);
          fs.writeFileSync(${JSON.stringify(released)}, '');
        });
      `], {env: ENV, stdio: 'ignore'})
      t.after(() => holder.kill())
      const until = Date.now() + 10000
      while (!fs.existsSync(ready) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20))
      assert.ok(fs.existsSync(ready), 'the other process acquired the lock')
      Remote.sync(w.op)
      assert.ok(fs.existsSync(released), 'the live owner released its own lock before sync')
    })
  })

  describe('CLI exchange', () => {
    it('counts a profile selected at signed room creation across machines and refuses states outside it', t => {
      const review: Profile = {
        schema: 'ringi-profile/1', name: 'review-1', opens: 'change',
        states: ['draft', 'in-review', 'approved', 'shipped'], initial: 'draft', terminal: ['shipped'],
        rules: {assign: ['requester'], roles: ['requester'], 'state:in-review': ['assignee'], 'state:approved': ['role:reviewer'], 'state:shipped': ['assignee']},
      }
      const w = world(t, undefined, review), codex = w.agent('codex', 'worker')
      w.ok('root', ['hub', 'switch', 'team'])
      w.ok('root', ['room', 'create', 'chosen', '--profile', review.name])
      const chosen = room(w.op, 'chosen')
      assert.deepEqual(JSON.parse(w.op.git(['show', `${chosen.genesis}:profile.json`])), review)
      const key = Remote.join(codex.H, room(codex.H), 'codex').publicKey
      w.ok('root', ['room', 'admit', 'codex', key, '--room', 'chosen'])
      w.ok('worker', ['join', 'team', 'chosen', '--as', 'codex'], 'chat-codex')
      assert.match(w.ok('worker', ['agent', 'profile'], 'chat-codex'), /follows profile review-1[\s\S]*opens with Kind: change/)
      w.ok('root', ['send', '--task', '--assign', 'codex', '--roles', 'operator=reviewer', '-m', 'Review the change'])
      const inbox: ReturnType<typeof asJson>[] = JSON.parse(w.ok('worker', ['agent', 'inbox', '--json'], 'chat-codex'))
      const change = inbox.find(m => m.kind === 'change')!
      assert.equal(change.trust, 'verified')
      const ready = /sent (\w+)/.exec(w.ok('worker', ['agent', 'reply', change.id, '--state', 'in-review', '-m', 'Ready'], 'chat-codex'))![1]
      assert.equal(JSON.parse(w.ok('root', ['tasks', '--all', '--json']))[0].state, 'in-review')
      const approved = /sent (\w+)/.exec(w.ok('root', ['reply', ready, '--state', 'approved', '-m', 'Reviewed']))![1]
      Remote.sync(codex.H)
      const R = room(codex.H, 'chosen'), ref = R.ref
      const bad = message(codex.H, codex.home, 'codex', `outside profile\n\nTo: operator\nRe: ${change.id}\nState: completed\n`, [codex.H.rev(ref)!])
      codex.H.git(['update-ref', ref, bad])
      Remote.push(codex.H, ref)
      const log: ReturnType<typeof asJson>[] = JSON.parse(w.ok('root', ['log', '--all', '--json']))
      assert.match(log.find(m => m.id === bad)!.bad!, /State completed is not in profile review-1/)
      w.ok('worker', ['agent', 'reply', approved, '--state', 'shipped', '-m', 'Shipped'], 'chat-codex')
      const [task] = JSON.parse(w.ok('root', ['tasks', '--all', '--json']))
      assert.deepEqual([task.state, task.by], ['shipped', 'codex'])
      const signals: Array<{signal: string, actor: string, ok: boolean}> = JSON.parse(w.ok('root', ['signals', '--all', '--json']))
      for (const [signal, actor] of [['state.in-review', 'codex'], ['state.approved', 'operator'], ['state.shipped', 'codex']]) assert.ok(signals.some(s => s.signal === signal && s.actor === actor && s.ok))
      assert.ok(!signals.some(s => s.signal === 'state.completed'))
    })

    it('exchanges a task and signed completion between two machines', t => {
      const w = world(t)
      const codex = w.agent('codex', 'worker')
      w.ok('root', ['hub', 'switch', 'team'])
      w.ok('root', ['room', 'switch', 'r'])
      assert.match(w.ok('worker', ['join', 'team', 'r', '--as', 'codex', '--scope', 'implement tasks; no publication'], 'chat-codex'), /joined team\/r as codex/)
      w.ok('root', ['send', '--task', '--assign', 'codex', '-m', 'Deliver result'])
      const inbox: ReturnType<typeof asJson>[] = JSON.parse(w.ok('worker', ['agent', 'inbox', '--json'], 'chat-codex'))
      const task = inbox.find(m => m.kind === 'task')
      assert.ok(task)
      assert.equal(task.trust, 'verified')
      w.ok('worker', ['agent', 'take', task.id], 'chat-codex')
      const [taken] = JSON.parse(w.ok('root', ['tasks', '--all', '--json']))
      assert.deepEqual([taken.state, taken.assignees, taken.taken], ['submitted', ['codex'], ['codex']])
      assert.match(w.ok('root', ['read', task.id]), /read by: codex[\s\S]*taken by: codex/)
      w.ok('worker', ['agent', 'reply', task.id, '--state', 'completed', '-m', 'Done'], 'chat-codex')
      const tasks = JSON.parse(w.ok('root', ['tasks', '--all', '--json']))
      assert.equal(tasks[0].state, 'completed')
      assert.equal(tasks[0].by, 'codex')
      const signals: Array<{signal: string, actor: string, ok: boolean}> = JSON.parse(w.ok('root', ['signals', '--all', '--json']))
      assert.ok(signals.some(s => s.signal === 'state.completed' && s.actor === 'codex' && s.ok), 'completion tag was signed, published and verified on the other machine')
      for (const mark of ['read', 'taken']) assert.ok(signals.some(s => s.signal === mark && s.actor === 'codex' && s.ok), `${mark} mark was signed, published and verified on the other machine`)
      assert.equal(fs.existsSync(path.join(codex.home, 'keys', 'team', 'operator')), false)
      const operatorHead = codex.H.rev('refs/heads/r')!
      const forged = message(codex.H, codex.home, 'operator', 'Never deliver this\n\nTo: codex\n', [operatorHead], {signer: 'codex'})
      publish(codex.H, 'refs/heads/r', forged)
      const withheld = w.run('worker', ['agent', 'inbox', '--json'], 'chat-codex')
      assert.equal(withheld.code, 0, withheld.err)
      assert.match(withheld.err, /ALARM.*operator.*signature/s)
      assert.deepEqual(JSON.parse(withheld.out), [])
    })
  })
})

describe('signed remote heartbeats', () => {
  const facts = (state = 'working') => `State: ${state}\nAlive: unknown\nQuiet: 0\nNext: 30\n`
  const put = (a: {H: Hub, home: string}, who: string, text = facts(), target?: string) => {
    const R = room(a.H), ref = Remote.heartbeatRef(who, R.genesis)
    const prev = a.H.git(['rev-parse', '-q', '--verify', ref], {ok: true})
    const old = prev.status === 0 ? prev.stdout.trim() : null
    const object = Remote.makeHeartbeat(a.H, R, who, target ?? a.H.rev(R.ref)!, text)
    a.H.git(['update-ref', ref, object, old ?? '0'.repeat(40)])
    return {R, ref, object, old}
  }

  it('publishes a signed beat on the pulled tip and replaces it without acceptance pins', t => {
    const w = world(t), bob = w.agent('bob'), R = room(bob.H)
    const before = w.op.rev(R.ref)
    const first = put(bob, 'bob')
    assert.equal(Remote.pushHeartbeat(bob.H, first.R, 'bob', first.object, first.old), true)
    Remote.sync(w.op)
    assert.equal(w.op.git(['rev-parse', first.ref]).trim(), first.object)
    assert.equal(w.op.git(['rev-parse', `${first.ref}^{commit}`]).trim(), before)
    assert.equal(Remote.verifyHeartbeat(w.op, room(w.op), first.ref, first.object), null)
    assert.match(w.op.git(['cat-file', 'tag', first.object]), new RegExp(`Room: ${R.genesis}\\n`))
    const second = put(bob, 'bob', facts('waiting'), R.genesis)
    assert.equal(second.old, first.object)
    assert.equal(Remote.pushHeartbeat(bob.H, second.R, 'bob', second.object, second.old), true)
    Remote.sync(w.op)
    assert.equal(w.op.git(['rev-parse', second.ref]).trim(), second.object)
    assert.notEqual(first.object, second.object)
    assert.equal(w.op.rev(R.ref), before, 'beats never append to the room')
    assert.equal(w.op.git(['for-each-ref', '--format=%(refname)', 'refs/ringi/remote-accepted-tags/']).trim(), '')
    assert.deepEqual(w.op.remoteAlarms, {})
    assert.throws(() => Remote.push(bob.H, second.ref), /expected object id/)
  })

  it('publishes through pulse and exposes verified facts on another machine without renewing the session', t => {
    const w = world(t)
    w.agent('bob')
    w.ok('bob', ['join', 'team', 'r', '--as', 'bob'], 'heartbeat-bob')
    const before = JSON.parse(w.ok('bob', ['sessions', '--json']))[0].lastSeen
    const first = w.run('bob', ['pulse', '--once'])
    assert.equal(first.code, 0, first.err)
    assert.equal(first.err, '')
    const beats = JSON.parse(w.ok('root', ['heartbeats', '--published', '--json', '--hub', 'team', '--room', 'r']))
    assert.equal(beats.length, 1)
    assert.deepEqual([beats[0].agent, beats[0].state, beats[0].target], ['bob', 'working', w.op.rev('refs/heads/r')])
    assert.match(beats[0].text, /^Room: [0-9a-f]{40}\n/)
    assert.equal(JSON.parse(w.ok('bob', ['sessions', '--json']))[0].lastSeen, before)
    const signals = JSON.parse(w.ok('root', ['signals', '--all', '--json', '--hub', 'team', '--room', 'r']))
    assert.ok(!signals.some((s: {ref: string}) => Remote.heartbeatName(s.ref)))
  })

  it('rejects lightweight, unsigned, foreign-key, wrong-room and off-branch telemetry', t => {
    const w = world(t), bob = w.agent('bob'), alice = w.agent('alice')
    Remote.sync(bob.H)
    const R = room(bob.H), ref = Remote.heartbeatRef('bob', R.genesis), name = ref.slice('refs/tags/'.length)
    const body = `Room: ${R.genesis}\n${facts()}`
    const tip = bob.H.rev(R.ref)!
    const other = R.genesis.slice(0, 12) + (R.genesis.slice(12) === '0'.repeat(28) ? '1' : '0').repeat(28)
    for (const [opts, expected] of [
      [{signed: false}, /signature/],
      [{signer: 'alice'}, /signature/],
      [{target: w.genesis}, /not on this room branch/],
      [{text: body.replace(R.genesis, other)}, /another room genesis/],
      [{text: facts()}, /full room genesis/],
      [{text: body + 'State: waiting\n'}, /duplicate heartbeat field/],
    ] as const) {
      // Both agents' fixture keys are known locally to forge exactly the wrong signer.
      if (opts.signer) {
        fs.mkdirSync(path.join(bob.home, 'keys', 'team'), {recursive: true})
        fs.copyFileSync(path.join(alice.home, 'keys', 'team', 'alice'), path.join(bob.home, 'keys', 'team', 'alice'))
      }
      const bad = tag(bob.H, bob.home, 'bob', tip, {name, text: body, ...opts})
      assert.match(Remote.verifyHeartbeat(bob.H, R, ref, bad.object)!, expected)
    }
    bob.H.git(['update-ref', ref, tip])
    assert.match(Remote.verifyHeartbeat(bob.H, R, ref, tip)!, /annotated tag/)
    const valid = put(bob, 'bob')
    assert.match(Remote.verifyHeartbeat(bob.H, {...R, genesis: other}, ref, valid.object)!, /another room genesis/)
    const eve = w.replica('eve')
    Remote.join(eve.H, room(eve.H), 'eve') // a key exists, but has never been admitted
    assert.throws(() => Remote.makeHeartbeat(eve.H, room(eve.H), 'eve', eve.H.rev(R.ref)!, facts()), /unadmitted/)
  })

  it('uses explicit creation and replacement leases and refuses a superseded local beat', t => {
    const w = world(t), bob = w.agent('bob')
    const first = put(bob, 'bob')
    assert.equal(Remote.pushHeartbeat(bob.H, first.R, 'bob', first.object, null), true)
    const second = put(bob, 'bob', facts('waiting'))
    assert.equal(Remote.pushHeartbeat(bob.H, second.R, 'bob', second.object, null), false, 'create must not replace an existing beat')
    assert.equal(w.op.git(['ls-remote', '--refs', w.url, second.ref]).trim().split(/\s+/)[0], first.object)
    assert.equal(Remote.pushHeartbeat(bob.H, second.R, 'bob', second.object, first.object), true)
    const third = put(bob, 'bob', facts('gone'))
    assert.equal(Remote.pushHeartbeat(bob.H, second.R, 'bob', second.object, first.object), false, 'an older local writer cannot publish over a newer one')
    assert.equal(Remote.pushHeartbeat(bob.H, third.R, 'bob', third.object, first.object), false, 'stale replacement does not overwrite the remote')
    assert.equal(Remote.pushHeartbeat(bob.H, third.R, 'bob', third.object, second.object), true)
    assert.deepEqual(pushAlarmsOf(bob.H), {})
  })

  it('withholds forged replacements and recovers valid telemetry without poisoning room history', t => {
    const w = world(t), bob = w.agent('bob')
    const good = put(bob, 'bob')
    assert.equal(Remote.pushHeartbeat(bob.H, good.R, 'bob', good.object, null), true)
    Remote.sync(w.op)
    const fake = tag(bob.H, bob.home, 'bob', bob.H.rev(good.R.ref)!, {
      name: good.ref.slice('refs/tags/'.length), signed: false, text: `Room: ${good.R.genesis}\n${facts('waiting')}`,
    })
    publish(bob.H, fake.ref, fake.object, true)
    Remote.sync(w.op)
    assert.equal(w.op.git(['rev-parse', '-q', '--verify', good.ref], {ok: true}).status, 1)
    assert.match(w.op.heartbeatErrors?.[good.ref]!, /signature/)
    assert.deepEqual(w.op.remoteAlarms, {})
    assert.equal(Remote.verifyRoom(w.op, room(w.op))!.genesis, good.R.genesis)
    const restored = put(bob, 'bob', facts('waiting'))
    assert.equal(Remote.pushHeartbeat(bob.H, restored.R, 'bob', restored.object, fake.object), true)
    Remote.sync(w.op)
    assert.equal(Remote.verifyHeartbeat(w.op, room(w.op), restored.ref, restored.object), null)
    assert.deepEqual(w.op.heartbeatErrors, {})
  })

  it('treats heartbeat deletion as missing telemetry while ordinary signal replacement still alarms', t => {
    const w = world(t), bob = w.agent('bob'), task = openTask(bob.H, bob.home, 'bob')
    const signal = tag(bob.H, bob.home, 'bob', task, {signal: 'heartbeat.extra'})
    assert.equal(Remote.heartbeatName(signal.ref), null, 'only the exact class is mutable')
    Remote.push(bob.H, signal.ref)
    const beat = put(bob, 'bob')
    Remote.pushHeartbeat(bob.H, beat.R, 'bob', beat.object, null)
    Remote.sync(w.op)
    bob.H.git(['push', '-q', 'origin', `:${beat.ref}`])
    Remote.sync(w.op)
    assert.equal(w.op.git(['rev-parse', '-q', '--verify', beat.ref], {ok: true}).status, 1)
    assert.deepEqual(w.op.remoteAlarms, {})
    const replacement = tag(bob.H, bob.home, 'bob', task, {signal: 'heartbeat.extra', date: '2002-02-02T00:00:00Z'})
    publish(bob.H, replacement.ref, replacement.object, true)
    Remote.sync(w.op)
    assert.match(w.op.remoteAlarms?.[signal.ref]!, /replaced/)
  })

  it('never silently waives an existing immutable pin in the heartbeat namespace', t => {
    const w = world(t), bob = w.agent('bob'), beat = put(bob, 'bob')
    Remote.pushHeartbeat(bob.H, beat.R, 'bob', beat.object, null)
    Remote.sync(w.op)
    const pin = 'refs/ringi/remote-accepted-tags/' + beat.ref.slice('refs/tags/'.length)
    w.op.git(['update-ref', pin, beat.object])
    const next = put(bob, 'bob', facts('waiting'))
    Remote.pushHeartbeat(bob.H, next.R, 'bob', next.object, beat.object)
    Remote.sync(w.op)
    assert.equal(w.op.git(['rev-parse', pin]).trim(), beat.object)
    assert.match(w.op.remoteAlarms?.[beat.ref]!, /previously accepted signal/)
    assert.match(Remote.verifyHeartbeat(w.op, room(w.op), beat.ref, beat.object)!, /previously accepted signal/)
  })
})
