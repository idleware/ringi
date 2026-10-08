// Independent signed writers and file:// replicas: the hub cannot supply its own trust anchor.
import {describe, it} from 'node:test'
import type {TestContext} from 'node:test'
import type {SpawnSyncOptions, SpawnSyncReturns} from 'node:child_process'
import type {Descriptor} from '../../main/ts/store/index.ts'
import type {asJson} from '../../main/ts/app/view.ts'
import type {Profile} from '../../main/ts/domain/profiles.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import childProcess, {spawn, spawnSync} from 'node:child_process'
import {syncBuiltinESMExports} from 'node:module'
import {fileURLToPath, pathToFileURL} from 'node:url'
import * as Remote from '../../main/ts/store/git/remote.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(HERE, '../../../target/esm/cli.js')
const BASE = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|CODEX|CURSOR|RINGI_|GIT_)/.test(k)))
const ENV = {...BASE, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0'}
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
  return {name, dir, d, git: ((args: string[], opt?: GitOpt) => git(dir, args, opt)) as Hub['git'], rev,
    isAncestor: (a, b) => !!a && !!b && git(dir, ['merge-base', '--is-ancestor', a, b], {ok: true}).status === 0,
    main: rev('refs/heads/main') ?? undefined}
}
const room = (H: Hub, name = 'r'): Remote.Room => {
  const control = `refs/heads/${name}/control`
  const head = H.rev(control) ?? assert.fail('missing room control')
  const genesis = H.git(['rev-list', '--reverse', head, '^refs/heads/main']).trim().split('\n')[0]
  return {name, control, head, genesis, log: who => `refs/heads/${name}/log/${who}`}
}
const tree = (H: Hub, files: Record<string, string> = {}, trees: Record<string, string> = {}) => {
  const entries = Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([p, text]) => `100644 blob ${H.git(['hash-object', '-w', '--stdin'], {input: text}).trim()}\t${p}`)
  for (const [p, sha] of Object.entries(trees)) entries.push(`040000 tree ${sha}\t${p}`)
  return H.git(['mktree'], {input: entries.join('\n') + (entries.length ? '\n' : '')}).trim()
}
const commit = (H: Hub, home: string, who: string, text: string, tr: string, ps: string[], {unsigned = false}: {unsigned?: boolean} = {}) => H.git([
  '-c', 'gpg.format=ssh', '-c', 'gpg.ssh.program=ssh-keygen', 'commit-tree',
  ...(!unsigned ? [`-S${path.join(home, 'keys', H.name, who)}`] : []), tr, ...ps.flatMap(p => ['-p', p]),
], {input: text, env: {GIT_AUTHOR_NAME: who, GIT_AUTHOR_EMAIL: `${who}@fixture`, GIT_COMMITTER_NAME: who, GIT_COMMITTER_EMAIL: `${who}@fixture`}}).trim()
const message = (H: Hub, home: string, who: string, text: string, ps: string[], opt?: {unsigned?: boolean}) => commit(H, home, who, text, tree(H), ps, opt)
const publish = (H: Hub, ref: string, sha: string, force = false) => H.git(['push', '-q', ...(force ? ['--force'] : []), 'origin', `${sha}:${ref}`])
const tag = (H: Hub, home: string, actor: string, message: string, {signed = true, signer = actor, target = message, signal = 'opened', text, date}: {
  signed?: boolean, signer?: string, target?: string, signal?: string, text?: string, date?: string
} = {}) => {
  const R = room(H), name = `ringi/${R.genesis}/${actor}/${message}.${signal}`
  const body = text ?? `${signal}\n\nRoom: ${R.name}\nGenesis: ${R.genesis}\nActor: ${actor}\nMessage: ${message}\nSignal: ${signal}\n`
  H.git(['-c', 'gpg.format=ssh', '-c', 'gpg.ssh.program=ssh-keygen', '-c', `user.signingkey=${path.join(home, 'keys', H.name, signer)}`,
    'tag', '-f', signed ? '-s' : '-a', '-F', '-', name, target], {input: body,
    env: {GIT_COMMITTER_NAME: actor, GIT_COMMITTER_EMAIL: `${actor}@fixture`, ...(date ? {GIT_COMMITTER_DATE: date} : {})}})
  const ref = `refs/tags/${name}`
  return {ref, object: H.git(['rev-parse', ref]).trim()}
}
const openTask = (H: Hub, home: string, who: string, subject = 'work'): string => {
  const R = room(H), ref = R.log(who)
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
  const setup = Remote.setupSigned(op, opHome, url)
  const meta = {schema: 'ringi-hub', version: spec ? '1.1' : '1.0', protocol: 1, capabilities: ['decisions/1', ...(spec ? ['profiles/1'] : [])], trust: 'signed', root: setup.root, ...(profile ? {profile} : {})}
  const mainTree = tree(op, {[spec ? 'contract.json' : 'hub.json']: JSON.stringify(meta), 'authority.json': '{"decide":{}}', 'HUB.md': '# independent fixture\n'}, spec ? {profiles: tree(op, {[`${spec.name}.json`]: JSON.stringify(spec)})} : {})
  const genesis = commit(op, opHome, 'operator', 'fixture hub\n\nTo: *\nKind: hub\n', mainTree, [])
  op.git(['update-ref', 'refs/heads/main', genesis]); op.main = genesis; op.d.genesis = genesis
  op.git(['remote', 'add', 'origin', url])
  // The operator's descriptor: the store and the pins this machine holds (ringi-hub/2).
  fs.writeFileSync(path.join(opHome, 'hub', 'team', 'hub.json'), JSON.stringify({schema: 'ringi-hub/2', name: 'team', trust: 'signed', root: setup.root, genesis,
    store: {type: 'git', path: 'store', remote: url}}))
  Remote.push(op, 'refs/heads/main')
  const ctlTree = tree(op, {'members.json': '{"operator":{"role":"root"}}', allowed_signers: setup.allowedSigners, 'ROOM.md': '# r\n', ...(spec ? {'profile.json': JSON.stringify(spec)} : {})})
  const ctl = commit(op, opHome, 'operator', `room r\n\nTo: *\nKind: room\nRoom-Id: ${crypto.randomBytes(16).toString('hex')}\n`, ctlTree, [genesis])
  op.git(['update-ref', 'refs/heads/r/control', ctl])
  Remote.push(op, 'refs/heads/r/control')
  const replica = (machine: string, {pin = genesis, root = setup.root}: {pin?: string, root?: string} = {}) => {
    const h = home(machine)
    Remote.hubAdd({home: h, name: 'team', url, root, genesis: pin})
    return {H: hub(h), home: h}
  }
  const agent = (who: string, machine = who) => {
    const a = replica(machine)
    const pending = Remote.join(a.H, room(a.H), who, a.home)
    assert.equal(pending.admitted, false)
    Remote.roomAdmit(op, room(op), who, pending.publicKey, opHome)
    Remote.sync(a.H)
    assert.equal(Remote.join(a.H, room(a.H), who, a.home).admitted, true)
    return a
  }
  const run = (machine: string, args: string[], session?: string) => {
    const r = spawnSync(process.execPath, [CLI, ...args], {encoding: 'utf8', env: {...ENV, RINGI_HOME: home(machine), ...(session ? {RINGI_SESSION: session} : {})}})
    return {code: r.status, out: r.stdout, err: r.stderr}
  }
  const ok = (machine: string, args: string[], session?: string) => { const r = run(machine, args, session); assert.equal(r.code, 0, `ringi ${args.join(' ')}: ${r.err}`); return r.out }
  return {base, remote, url, home, op, opHome, meta, genesis, replica, agent, run, ok}
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
      const key = Remote.setupSigned(alien, alienHome).root
      assert.throws(() => w.replica('wrong-pin', {root: key}), /ALARM.*signature/)
      assert.equal(fs.existsSync(path.join(w.home('wrong-pin'), 'hub', 'team')), false)
      assert.throws(() => w.replica('wrong-genesis', {pin: '0'.repeat(40)}), /pinned genesis/)
      const a = w.replica('reader')
      assert.equal(Remote.verifyHub(a.H)!.genesis, w.genesis)
      assert.equal(fs.existsSync(path.join(a.home, 'keys')), false, 'cloning public history must not acquire a root private key')
      assert.throws(() => Remote.sign(a.H, 'operator', a.home), /no private key.*operator/)
    })

    it('withholds unadmitted logs until root admission', t => {
      const w = world(t)
      const a = w.replica('bob')
      const key = Remote.join(a.H, room(a.H), 'bob', a.home)
      assert.equal(key.admitted, false)
      const sha = message(a.H, a.home, 'bob', 'pending\n\nTo: operator\n', [room(a.H).genesis])
      publish(a.H, 'refs/heads/r/log/bob', sha)
      Remote.sync(w.op)
      assert.match(w.op.remoteAlarms?.['refs/heads/r/log/bob'] ?? '', /unadmitted/)
      assert.equal(w.op.rev('refs/heads/r/log/bob'), null)
      assert.match(Remote.verify(w.op, room(w.op), 'bob', sha)!, /unadmitted/)
      Remote.roomAdmit(w.op, room(w.op), 'bob', key.publicKey, w.opHome)
      Remote.sync(w.op)
      assert.equal(w.op.rev('refs/heads/r/log/bob'), sha)
      assert.equal(Remote.verify(w.op, room(w.op), 'bob', sha), null)
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
    it('withholds copied room controls and logs under another name', t => {
      const w = world(t), R = room(w.op)
      const sha = openTask(w.op, w.opHome, 'operator', 'original room work')
      const signal = tag(w.op, w.opHome, 'operator', sha)
      Remote.push(w.op, signal.ref)
      for (const name of ['aaa', 'zzz']) {
        git(w.remote, ['update-ref', `refs/heads/${name}/control`, R.head])
        git(w.remote, ['update-ref', `refs/heads/${name}/log/operator`, sha])
      }
      const added = w.run('reader', ['hub', 'add', 'team', w.url, '--root', w.op.d.root!, '--genesis', w.genesis])
      assert.equal(added.code, 0, added.err)
      assert.match(added.out, /1 room\(s\)/)
      const reader = hub(w.home('reader')), accepted = room(reader)
      Remote.withVerification(reader, () => {
        Remote.verifyRoom(reader, accepted)
        assert.throws(() => Remote.verifyRoom(reader, {...accepted, name: 'zzz'}), /genesis subject.*room zzz/)
      })
      assert.equal(reader.rev(R.log('operator')), sha)
      assert.equal(reader.git(['rev-parse', signal.ref]).trim(), signal.object)
      for (const name of ['aaa', 'zzz']) {
        assert.match(added.err, new RegExp(`ALARM ${name}/control:.*genesis subject.*room ${name}`))
        assert.match(added.err, new RegExp(`ALARM ${name}/log/operator:.*control is missing or quarantined`))
        assert.equal(reader.rev(`refs/heads/${name}/control`), null)
        assert.equal(reader.rev(`refs/ringi/remote-accepted/${name}/control`), null)
        assert.equal(reader.rev(`refs/heads/${name}/log/operator`), null)
        const read = w.run('reader', ['log', '--hub', 'team', '--room', name])
        assert.notEqual(read.code, 0)
        assert.match(read.err, new RegExp(`no room ${name}`))
      }
      const log: ReturnType<typeof asJson>[] = JSON.parse(w.ok('reader', ['log', '--hub', 'team', '--room', 'r', '--all', '--json']))
      assert.equal(log.find(m => m.id === sha)!.trust, 'verified')
    })

    it('withholds unsigned and wrong-principal extensions', t => {
      const w = world(t)
      const bob = w.agent('bob')
      const alice = w.agent('alice')
      Remote.sync(bob.H)
      const good = message(alice.H, alice.home, 'alice', 'good\n\nTo: bob\n', [room(alice.H).genesis])
      publish(alice.H, 'refs/heads/r/log/alice', good)
      Remote.sync(bob.H)
      assert.equal(bob.H.rev('refs/heads/r/log/alice'), good)
      const forged = message(bob.H, bob.home, 'bob', 'forged\n\nTo: bob\n', [good])
      publish(bob.H, 'refs/heads/r/log/alice', forged)
      Remote.sync(bob.H)
      assert.match(bob.H.remoteAlarms?.['refs/heads/r/log/alice'] ?? '', /signature.*alice/)
      assert.equal(bob.H.rev('refs/heads/r/log/alice'), good)
      assert.match(Remote.verify(bob.H, room(bob.H), 'alice', good)!, /signature/)
      const unsigned = message(bob.H, bob.home, 'bob', 'unsigned\n\nTo: bob\n', [good], {unsigned: true})
      publish(bob.H, 'refs/heads/r/log/alice', unsigned, true)
      Remote.sync(bob.H)
      assert.match(bob.H.remoteAlarms?.['refs/heads/r/log/alice'] ?? '', /signature/)
      assert.equal(bob.H.rev('refs/ringi/remote-accepted/r/log/alice'), good)
    })

    it('refuses duplicate authority fields and agent-signed control', t => {
      const w = world(t)
      const bob = w.agent('bob')
      const old = room(w.op).head
      const fakeControl = commit(bob.H, bob.home, 'bob', 'admit mallory\n\nTo: *\nKind: room\n', bob.H.git(['rev-parse', `${old}^{tree}`]).trim(), [old])
      publish(bob.H, 'refs/heads/r/control', fakeControl)
      Remote.sync(w.op)
      assert.match(w.op.remoteAlarms?.['refs/heads/r/control'] ?? '', /signature.*operator/)
      assert.throws(() => Remote.verifyRoom(w.op, room(w.op)), /quarantined/)
      publish(w.op, 'refs/heads/r/control', old, true)
      Remote.sync(w.op)
      const tr = tree(w.op, {'hub.json': JSON.stringify(w.meta), 'authority.json': '{"decide":{},"decide":{"bob":{"runs":999}}}'})
      const bad = commit(w.op, w.opHome, 'operator', 'ambiguous authority\n\nTo: *\nKind: hub\n', tr, [w.genesis])
      publish(w.op, 'refs/heads/main', bad)
      assert.throws(() => Remote.sync(w.op), /ALARM.*duplicate JSON/)
      assert.equal(w.op.rev('refs/heads/main'), w.genesis)
    })

    it('refuses replay into another room', t => {
      const w = world(t)
      const bob = w.agent('bob')
      const original = room(bob.H)
      const ctlTree = w.op.git(['rev-parse', `${room(w.op).head}^{tree}`]).trim()
      const other = commit(w.op, w.opHome, 'operator', `room other\n\nTo: *\nKind: room\nRoom-Id: ${crypto.randomBytes(16).toString('hex')}\n`, ctlTree, [w.genesis])
      w.op.git(['update-ref', 'refs/heads/other/control', other])
      Remote.push(w.op, 'refs/heads/other/control')
      const sha = message(bob.H, bob.home, 'bob', 'belongs to r\n\nTo: operator\n', [original.genesis])
      publish(bob.H, 'refs/heads/other/log/bob', sha)
      Remote.sync(w.op)
      assert.match(w.op.remoteAlarms?.['refs/heads/other/log/bob'] ?? '', /room genesis/)
      assert.equal(w.op.rev('refs/heads/other/log/bob'), null)
    })
  })

  describe('replication and recovery', () => {
    it('alarms on rewrites, rollbacks and deletions until restoration', t => {
      const w = world(t)
      const bob = w.agent('bob')
      const first = message(bob.H, bob.home, 'bob', 'first\n\nTo: operator\n', [room(bob.H).genesis])
      const second = message(bob.H, bob.home, 'bob', 'second\n\nTo: operator\n', [first])
      publish(bob.H, 'refs/heads/r/log/bob', second)
      Remote.sync(w.op)
      const rewritten = message(bob.H, bob.home, 'bob', 'rewritten\n\nTo: operator\n', [first])
      publish(bob.H, 'refs/heads/r/log/bob', rewritten, true)
      Remote.sync(w.op)
      assert.match(w.op.remoteAlarms?.['refs/heads/r/log/bob'] ?? '', /rewritten|rolled back/)
      assert.equal(w.op.rev('refs/heads/r/log/bob'), second)
      publish(bob.H, 'refs/heads/r/log/bob', first, true)
      Remote.sync(w.op)
      assert.match(w.op.remoteAlarms?.['refs/heads/r/log/bob'] ?? '', /rolled back/)
      publish(bob.H, 'refs/heads/r/log/bob', second, true)
      Remote.sync(w.op)
      assert.equal(w.op.remoteAlarms?.['refs/heads/r/log/bob'], undefined)
      bob.H.git(['push', '-q', 'origin', ':refs/heads/r/log/bob'])
      Remote.sync(w.op)
      assert.match(w.op.remoteAlarms?.['refs/heads/r/log/bob'] ?? '', /deleted/)
      assert.equal(w.op.rev('refs/heads/r/log/bob'), second)
    })

    it('refuses merges and retains rejected publications', t => {
      const w = world(t)
      const bob = w.agent('bob')
      const R = room(bob.H)
      const first = message(bob.H, bob.home, 'bob', 'first\n\nTo: operator\n', [R.genesis])
      publish(bob.H, R.log('bob'), first)
      Remote.sync(w.op); Remote.sync(bob.H)
      const merge = message(bob.H, bob.home, 'bob', 'merge\n\nTo: operator\n', [first, R.genesis])
      publish(bob.H, R.log('bob'), merge)
      Remote.sync(w.op)
      assert.match(w.op.remoteAlarms?.[R.log('bob')] ?? '', /not linear/)
      publish(bob.H, R.log('bob'), first, true)
      const theirs = message(bob.H, bob.home, 'bob', 'theirs\n\nTo: operator\n', [first])
      const ours = message(bob.H, bob.home, 'bob', 'ours\n\nTo: operator\n', [first])
      publish(bob.H, R.log('bob'), theirs)
      bob.H.git(['update-ref', R.log('bob'), ours])
      assert.throws(() => Remote.push(bob.H, R.log('bob')), /ALARM.*push rejected/)
      assert.equal(bob.H.rev(R.log('bob')), ours)
      assert.equal(git(w.remote, ['rev-parse', R.log('bob')]).trim(), theirs)
      Remote.sync(bob.H)
      assert.match(bob.H.remoteAlarms?.[R.log('bob')] ?? '', /push rejected|diverges/)
    })

    it('retains evidence without waiving signatures after baseline acceptance', t => {
      const w = world(t)
      const bob = w.agent('bob')
      const R = room(bob.H)
      const first = message(bob.H, bob.home, 'bob', 'first\n\nTo: operator\n', [R.genesis])
      publish(bob.H, R.log('bob'), first)
      Remote.sync(w.op)
      const replacement = message(bob.H, bob.home, 'bob', 'replacement\n\nTo: operator\n', [R.genesis])
      publish(bob.H, R.log('bob'), replacement, true)
      Remote.sync(w.op)
      assert.match(w.op.remoteAlarms?.[R.log('bob')] ?? '', /rewritten/)
      Remote.forget(w.op, room(w.op), 'bob')
      Remote.sync(w.op)
      assert.equal(w.op.rev(R.log('bob')), replacement)
      assert.equal(w.op.rev(`refs/ringi/quarantine/${R.genesis}/bob/${first}`), first)
      const unsigned = message(bob.H, bob.home, 'bob', 'unsigned\n\nTo: operator\n', [R.genesis], {unsigned: true})
      publish(bob.H, R.log('bob'), unsigned, true)
      Remote.sync(w.op)
      assert.throws(() => Remote.forget(w.op, room(w.op), 'bob'), /signature/)
      assert.equal(w.op.rev(R.log('bob')), replacement)
    })
  })

  describe('signed signal tags', () => {
    it('publishes and pins the annotated object signed by its actor', t => {
      const w = world(t), bob = w.agent('bob')
      const sha = openTask(bob.H, bob.home, 'bob')
      const unrelated = message(bob.H, bob.home, 'bob', 'invalid unrelated control', [w.genesis])
      bob.H.git(['update-ref', 'refs/heads/aaa/control', unrelated])
      const s = tag(bob.H, bob.home, 'bob', sha)
      Remote.push(bob.H, s.ref)
      Remote.sync(w.op)
      assert.equal(w.op.git(['rev-parse', s.ref]).trim(), s.object)
      assert.notEqual(s.object, sha)
      assert.equal(w.op.rev(s.ref), sha)
      assert.equal(w.op.git(['rev-parse', s.ref.replace('refs/tags/ringi/', 'refs/ringi/remote-accepted-tags/')]).trim(), s.object)
      assert.equal(Remote.verifySignal(w.op, room(w.op), s.ref, s.object), null)
    })

    it('withholds unsigned, lightweight, wrong-principal and mismatched tags', t => {
      const w = world(t), bob = w.agent('bob'), alice = w.agent('alice')
      Remote.sync(bob.H)
      for (const [kind, why] of [
        ['unsigned', /bad or missing signature/],
        ['lightweight', /must be an annotated tag/],
        ['wrong-principal', /bad or missing signature/],
        ['body', /trailers disagree/],
        ['target', /name, actor or target disagrees/],
      ] as const) {
        const previous = bob.H.rev(room(bob.H).log('bob')) ?? room(bob.H).genesis
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
      bob.H.git(['update-ref', R.log('bob'), reply])
      Remote.push(bob.H, R.log('bob'))
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
      let head = R.genesis
      for (let i = 0; i < 12; i++) {
        head = message(bob.H, bob.home, 'bob', `message ${i}\n\nTo: alice\n`, [head])
        messages.push(head)
      }
      bob.H.git(['update-ref', R.log('bob'), head])
      Remote.push(bob.H, R.log('bob'))
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
      const R = room(bob.H), ref = R.log('bob')
      const sha = message(bob.H, bob.home, 'bob', 'work for alice\n\nTo: alice\nKind: task\n', [R.genesis])
      bob.H.git(['update-ref', ref, sha])
      Remote.push(bob.H, ref)
      Remote.sync(alice.H)
      assert.equal(alice.H.rev(R.log('alice')), null, 'a member need not have authored a message to mark one')
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

    it('rejects wrong signers, foreign targets and quarantined logs while keeping derived signals author-bound', t => {
      const w = world(t), bob = w.agent('bob'), alice = w.agent('alice')
      const sha = openTask(bob.H, bob.home, 'bob')
      const ctlTree = w.op.git(['rev-parse', `${room(w.op).head}^{tree}`]).trim()
      const other = commit(w.op, w.opHome, 'operator', 'room other\n\nTo: *\nKind: room\n', ctlTree, [w.genesis])
      w.op.git(['update-ref', 'refs/heads/other/control', other])
      Remote.push(w.op, 'refs/heads/other/control')
      const foreign = message(w.op, w.opHome, 'operator', 'foreign work\n\nTo: alice\nKind: task\n', [other])
      w.op.git(['update-ref', 'refs/heads/other/log/operator', foreign])
      Remote.push(w.op, 'refs/heads/other/log/operator')
      Remote.sync(alice.H)
      for (const [target, signal, signer, home, why] of [
        [sha, 'read', 'bob', bob.home, /bad or missing signature/],
        [w.genesis, 'read', 'alice', alice.home, /no accepted message of this room/],
        [room(alice.H).genesis, 'taken', 'alice', alice.home, /no message of this room/],
        [foreign, 'taken', 'alice', alice.home, /no accepted message of this room/],
        [sha, 'opened', 'alice', alice.home, /no accepted message of its actor/],
        [sha, 'usage.reserve', 'alice', alice.home, /no accepted message of its actor/],
        [sha, 'usage.settle', 'alice', alice.home, /no accepted message of its actor/],
      ] as const) {
        const s = tag(alice.H, home, 'alice', target, {signal, signer})
        assert.throws(() => Remote.push(alice.H, s.ref), why)
      }
      const R = room(bob.H)
      const unsigned = message(bob.H, bob.home, 'bob', 'bad extension\n\nTo: alice\n', [sha], {unsigned: true})
      publish(bob.H, R.log('bob'), unsigned)
      Remote.sync(alice.H)
      const s = tag(alice.H, alice.home, 'alice', sha, {signal: 'taken'})
      assert.throws(() => Remote.push(alice.H, s.ref), /no accepted message/)
    })
  })

  describe('transport contention', () => {
    it('waits for a live transport owner beyond five seconds', async t => {
      const w = world(t)
      const lock = path.join(w.op.dir, 'ringi', 'transport.lock')
      const ready = path.join(w.base, 'ready'), released = path.join(w.base, 'released')
      const util = pathToFileURL(path.join(HERE, '../../main/ts/lib/index.ts')).href
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
      const key = Remote.join(codex.H, room(codex.H), 'codex', codex.home).publicKey
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
      const R = room(codex.H, 'chosen'), ref = R.log('codex')
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

    it('replicates signed watcher usage without counting tags as spending', t => {
      const w = world(t), codex = w.agent('codex', 'worker')
      w.ok('root', ['hub', 'switch', 'team'])
      w.ok('root', ['room', 'switch', 'r'])
      w.ok('worker', ['join', 'team', 'r', '--as', 'codex'], 'chat-codex')
      const p = /proposed (\w+)/.exec(w.ok('worker', ['agent', 'propose', '-m', 'One watcher run', '--decider', 'operator', '--budget', 'runs=1,run-seconds=10'], 'chat-codex'))![1]
      const grant = /grant (\w+)/.exec(w.ok('root', ['decide', p, 'approved', '-m', 'go']))![1]
      w.ok('worker', ['leave'], 'chat-codex')
      w.ok('root', ['send', '--task', '--assign', 'codex', '--grant', grant, '-m', 'Run once'])
      w.ok('worker', ['watch', 'team:r/codex', '--exec', 'true', '--once', '--require-grant'])
      const receipts: ReturnType<typeof asJson>[] = JSON.parse(w.ok('root', ['log', '--all', '--json']))
      const usage = receipts.filter(m => m.kind === 'usage')
      assert.deepEqual(usage.map(m => m.trailers.usage[0]), ['reserve', 'settle'])
      const signals: Array<{ref: string, signal: string, actor: string, target: string, ok: boolean}> = JSON.parse(w.ok('root', ['signals', '--all', '--json']))
      const tags = signals.filter(s => s.signal.startsWith('usage.'))
      assert.equal(tags.length, 2)
      for (const m of usage) {
        const s = tags.find(s => s.target === m.id)!
        assert.deepEqual([s.actor, s.signal, s.ok], ['codex', `usage.${m.trailers.usage[0]}`, true])
        const raw = w.op.git(['rev-parse', s.ref]).trim()
        assert.equal(Remote.verifySignal(w.op, room(w.op), s.ref, raw), null)
      }
      const before = w.ok('root', ['grants'])
      assert.match(before, /spent +runs 1\/1, open 0/)
      const removed = tags.find(s => s.signal === 'usage.reserve')!
      const object = codex.H.git(['rev-parse', removed.ref]).trim()
      codex.H.git(['push', '-q', 'origin', `:${removed.ref}`])
      const read = w.run('root', ['signals', '--all', '--json'])
      assert.equal(read.code, 0, read.err)
      assert.match(read.err, /ALARM.*signal.*deleted/)
      assert.equal(w.ok('root', ['grants']), before, 'deleting a tag cannot refund or recount a receipt')
      publish(codex.H, removed.ref, object)
      const restored = w.run('root', ['signals', '--all', '--json'])
      assert.equal(restored.code, 0, restored.err)
      assert.doesNotMatch(restored.err, /ALARM/)
      assert.equal(w.ok('root', ['grants']), before, 'restoring a tag does not double-count spending')
    })

    it('exchanges a granted task and signed completion between two machines', t => {
      const w = world(t)
      const codex = w.agent('codex', 'worker')
      w.ok('root', ['hub', 'switch', 'team'])
      w.ok('root', ['room', 'switch', 'r'])
      assert.match(w.ok('worker', ['join', 'team', 'r', '--as', 'codex', '--scope', 'implement tasks; no publication'], 'chat-codex'), /joined team\/r as codex/)
      const p = /proposed (\w+)/.exec(w.ok('worker', ['agent', 'propose', '-m', 'One bounded run', '--decider', 'operator', '--budget', 'runs=1,run-seconds=10'], 'chat-codex'))![1]
      const decision = w.ok('root', ['decide', p, 'approved', '-m', 'go'])
      const grant = /grant (\w+)/.exec(decision)![1]
      w.ok('root', ['send', '--task', '--assign', 'codex', '--grant', grant, '-m', 'Deliver result'])
      const inbox: ReturnType<typeof asJson>[] = JSON.parse(w.ok('worker', ['agent', 'inbox', '--json'], 'chat-codex'))
      const task = inbox.find(m => m.kind === 'task')
      assert.ok(task)
      assert.equal(task.trust, 'verified')
      assert.ok(task.trailers.grant[0].startsWith(grant))
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
      const operatorHead = codex.H.rev('refs/heads/r/log/operator')!
      const forged = message(codex.H, codex.home, 'codex', 'Never deliver this\n\nTo: codex\n', [operatorHead])
      publish(codex.H, 'refs/heads/r/log/operator', forged)
      const withheld = w.run('worker', ['agent', 'inbox', '--json'], 'chat-codex')
      assert.equal(withheld.code, 0, withheld.err)
      assert.match(withheld.err, /ALARM.*operator.*signature/)
      assert.deepEqual(JSON.parse(withheld.out), [])
    })
  })
})
