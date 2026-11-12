// Explicit asserted controls are validated as names, membership and history, without making a Signer claim.
import {describe, it} from 'node:test'
import type {TestContext} from 'node:test'
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import fs from 'node:fs'
import {syncBuiltinESMExports} from 'node:module'
import os from 'node:os'
import path from 'node:path'
import {GitStore} from '../../main/ts/adapters/store-git/index.ts'
import {init} from '../../main/ts/adapters/store-git/repo.ts'
import {git, ident} from '../../main/ts/adapters/store-git/remote/git.ts'
import {branchData} from '../../main/ts/adapters/store-git/remote/branch.ts'
import {withVerification} from '../../main/ts/adapters/store-git/remote/cache.ts'
import {treeWith} from '../../main/ts/adapters/store-git/remote/control-tree.ts'
import {scanStream} from '../../main/ts/adapters/store-git/remote/streams.ts'
import {membershipFile, membershipText} from '../../main/ts/adapters/store-git/remote/membership.ts'
import type {Membership} from '../../main/ts/adapters/store-git/remote/membership.ts'
import type {Descriptor, RoomEndpointV2} from '../../main/ts/core/hub/ports/store.ts'
import type {SigningContext} from '../../main/ts/core/signing/index.ts'

const root = {operator: {role: 'root'}}
const control = (subject: string) => `${subject}\n\nTo: *\nKind: room\n`
const fixture = (t: TestContext) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ringi-asserted4-'))
  t.after(() => fs.rmSync(home, {recursive: true, force: true}))
  const signing = new Proxy({} as SigningContext, {get() {assert.fail('asserted path must never access an injected Signer or key resolver')}})
  const d: Descriptor = {schema: 'ringi-hub/3', name: 'test', trust: 'asserted', genesis: '', store: {type: 'git'}, contract: {path: 'contract'}}
  const source = GitStore.create(path.join(home, 'source'), d, {home, layout: 'git/4', signing}, {
    'contract.json': JSON.stringify({schema: 'ringi-hub', store: 'git/4', trust: 'asserted'}),
  }, 'hub fixture\n\nTo: *\nKind: hub\n')
  const at = path.join(home, 'room'), dir = path.join(at, 'store', '.git')
  fs.mkdirSync(path.dirname(dir), {recursive: true}); init(dir, home)
  const endpoint: RoomEndpointV2 = {schema: 'ringi-room/2', address: 'local://r', name: 'r', hubGenesis: d.genesis, genesis: '', trust: 'asserted',
    location: {directory: {path: at, identity: 'fixture'}, generation: 'fixture-1'}, store: {path: 'store'}}
  const store = new GitStore(at, d, home, {layout: 'git/4', signing}, endpoint)
  store.seedContract(source)
  store.createRoom('r', 'operator', control('room r'), {'members.json': membershipText({members: {...root, alice: {}, bob: {}}, retired: {}}, 'git/4'), 'profile.json': '{}', 'ROOM.md': '# r'})
  const hashes = () => git(store.h, ['for-each-ref', '--format=%(refname) %(objectname)'])
  const replace = (state: Membership, subject: string, who = 'operator', files: Record<string, string> = {}) =>
    store.updateControl(store.room('r')!, who, control(subject), {'members.json': membershipText(state, 'git/4'), ...files})
  return {home, store, endpoint, signing, hashes, replace}
}

describe('asserted git/4 controls without a Signer', () => {
  it('reads each stream control once and uses listed parent trees across a verified suffix', t => {
    const f = fixture(t), before = f.store.room('r')!
    const target = f.store.append(before, 'alice', 'task\n\nTo: bob\nKind: task\n', [])
    const updated = f.replace({members: {...root, alice: {}, bob: {}, charlie: {}}, retired: {}}, 'admit charlie')
    const H = {...f.store.h}, R = {...before, head: updated, ref: 'refs/heads/chat'}
    const tree = git(H, ['rev-parse', `${R.genesis}^{tree}`]).trim()
    const records: string[] = []
    for (const [i, control] of [R.genesis, R.genesis, updated, updated, updated].entries()) {
      const input = `Room: ${R.genesis}\nControl: ${control}\nTarget: ${target}\nSignal: test-${i}\n`
      records.push(git(H, ['commit-tree', tree, '-p', records.at(-1) ?? R.genesis], {input, env: ident('alice')}).trim())
    }

    withVerification(H, () => {
      branchData(H, R.name, updated, R.genesis)
      const membership: string[] = [], trees: string[] = []
      const original = childProcess.spawnSync
      const mock = t.mock.method(childProcess, 'spawnSync', (...args: Parameters<typeof childProcess.spawnSync>) => {
        const [, argv] = args
        if (Array.isArray(argv)) {
          const last = argv.at(-1) ?? ''
          if (argv.at(-3) === 'cat-file' && argv.at(-2) === 'blob' && last.endsWith(':members.json')) membership.push(last)
          if (argv.at(-2) === 'rev-parse' && last.endsWith('^{tree}')) trees.push(last)
        }
        return original(...args)
      })
      syncBuiltinESMExports()
      try {
        const first = scanStream({H, R, actor: 'alice', head: records[3]})
        assert.equal(first.why, undefined)
        assert.deepEqual(first.records.map(r => r.raw.sha), records.slice(0, 4))
        const suffix = scanStream({H, R, actor: 'alice', head: records[4]})
        assert.equal(suffix.why, undefined)
        assert.deepEqual(suffix.records.map(r => r.raw.sha), records)
        assert.deepEqual(membership, [`${R.genesis}:members.json`, `${updated}:members.json`])
        assert.deepEqual(trees, [`${R.genesis}^{tree}`])
      } finally {mock.mock.restore(); syncBuiltinESMExports()}
    })
  })
  it('retains a null-key terminal tombstone, historical chat, first removal and exact signal retry', t => {
    const f = fixture(t), before = f.store.room('r')!
    const task = f.store.append(before, 'alice', 'task\n\nTo: bob\nKind: task\n', [])
    f.store.signal(before, 'alice', task, 'opened')
    const stream = f.store.signalHeads(before)[0].head
    const removed = f.store.remove(before, 'operator', 'alice'), r = f.store.room('r')!
    assert.deepEqual(f.store.retirements(r), {alice: removed})
    assert.deepEqual(f.store.retirements(before), {})
    assert.equal(f.store.roster(r), null, 'asserted validation never returns verified cryptographic signers')
    assert.equal(f.store.verifyLog(r, 'alice', task), null)
    assert.equal(f.store.messages(r, 'alice', task)[0].id, task)
    assert.deepEqual(membershipFile(f.store.controlFile(r, 'members.json')!, 'git/4', false).retired.alice, {key: null, since: membershipFile(f.store.controlFile(r, 'members.json')!, 'git/4', false).retired.alice.since})
    const refs = f.hashes()
    assert.equal(f.store.remove(r, 'operator', 'alice'), removed)
    assert.throws(() => f.store.append(before, 'alice', 'late\n\nTo: bob\n', []), /not active|retired/)
    assert.throws(() => f.store.signal(before, 'alice', task, 'taken'), /not active|retired/)
    assert.throws(() => f.store.remove(r, 'bob', 'alice'), /root/)
    assert.throws(() => f.store.remove(r, 'operator', 'operator'), /root/)
    assert.throws(() => f.store.joinKey(r, 'alice'), /no signing identity/)
    assert.throws(() => f.store.admit(r, 'alice', 'anything'), /not signing-key admission/)
    assert.equal(f.hashes(), refs)
    f.store.signal(r, 'alice', task, 'opened')
    assert.equal(f.store.signalHeads(r)[0].head, stream)
    f.store.append(r, 'bob', 'still active\n\nTo: operator\n', [])
    assert.deepEqual(f.store.alarms(f.store.room('r')!), [])
  })
  it('refuses invalid controls before moving a ref, permits explicit new actor and keeps terminal names', t => {
    const f = fixture(t), initial = {members: {...root, alice: {}, bob: {}}, retired: {}}
    let refs = f.hashes()
    assert.throws(() => f.replace({members: {...root, bob: {}}, retired: {alice: {key: null, since: 'gone'}}}, 'edit'), /explicit remove/)
    assert.throws(() => f.replace(initial, 'edit', 'alice', {'ROOM.md': 'unauthorized'}), /only the root/)
    assert.throws(() => f.replace(initial, 'edit', 'operator', {allowed_signers: 'not cryptographic authority'}), /cannot declare cryptographic signers/)
    assert.equal(f.hashes(), refs)
    f.store.remove(f.store.room('r')!, 'operator', 'alice')
    const r = f.store.room('r')!, state = membershipFile(f.store.controlFile(r, 'members.json')!, 'git/4', false)
    refs = f.hashes()
    assert.throws(() => f.replace({...state, retired: {}}, 'edit'), /immutable/)
    assert.throws(() => f.replace({...state, members: {...state.members, alice: {}}}, 'admit alice'), /collision/)
    assert.throws(() => f.replace({...state, retired: {alice: {key: 'SHA256:' + 'a'.repeat(43), since: 'gone'}}}, 'edit'), /invalid retired/)
    assert.equal(f.hashes(), refs)
    f.replace({...state, members: {...state.members, 'alice-2': {}}}, 'admit alice-2')
    assert.deepEqual(f.store.retirements(f.store.room('r')!), {alice: r.head})
  })
  it('rejects malformed fetched asserted control history rather than accepting its retirement facts', t => {
    const f = fixture(t), r = f.store.room('r')!, tip = f.store.rev('refs/heads/chat')!
    const tree = treeWith(f.store.h, tip, r.head, {'members.json': membershipText({members: {...root, bob: {}}, retired: {alice: {key: null, since: 'forged'}}}, 'git/4')})
    const sha = git(f.store.h, ['commit-tree', tree, '-p', tip], {input: control('edit'), env: ident('operator')}).trim()
    git(f.store.h, ['update-ref', 'refs/heads/chat', sha, tip])
    assert.throws(() => f.store.room('r'), /explicit remove/)
    assert.deepEqual(f.store.retirements(r), {}, 'old accepted snapshot does not acquire a fact from a rejected suffix')
  })
  it('refuses an asserted contract that declares signed trust without accessing a Signer', t => {
    const f = fixture(t), head = f.store.contractHead()
    const tree = treeWith(f.store.h, head, head, {'contract.json': JSON.stringify({schema: 'ringi-hub', store: 'git/4', trust: 'signed'})})
    const bad = git(f.store.h, ['commit-tree', tree, '-p', head], {input: 'amend\n', env: ident('operator')}).trim()
    git(f.store.h, ['update-ref', 'refs/heads/main', bad, head])
    assert.throws(() => f.store.room('r'), /asserted trust/)
  })
  it('excludes a new malformed retired signal tail while keeping its asserted reader pin', t => {
    const f = fixture(t), before = f.store.room('r')!
    const task = f.store.append(before, 'alice', 'task\n\nTo: bob\nKind: task\n', [])
    f.store.signal(before, 'alice', task, 'opened')
    const first = f.store.signalHeads(before)[0].head
    f.store.pinSignals(before, 'reader', 'alice', first)
    f.store.remove(before, 'operator', 'alice')
    const r = f.store.room('r')!, raw = git(f.store.h, ['commit-tree', git(f.store.h, ['rev-parse', `${first}^{tree}`]).trim(), '-p', first], {input: 'malformed retired tail\n', env: ident('alice')}).trim()
    git(f.store.h, ['update-ref', 'refs/heads/alice/signals', raw])
    assert.deepEqual(f.store.signals(r).map(x => x.id), [first])
    assert.deepEqual(f.store.alarms(r), [])
    assert.equal(f.store.rev(`refs/ringi/accepted/${r.genesis}/reader/signals/alice`), first)
  })
  it('refuses an otherwise valid extension of a room frozen main', t => {
    const f = fixture(t), head = f.store.contractHead()
    const sha = git(f.store.h, ['commit-tree', git(f.store.h, ['rev-parse', `${head}^{tree}`]).trim(), '-p', head], {input: 'later asserted contract\n', env: ident('operator')}).trim()
    git(f.store.h, ['update-ref', 'refs/heads/main', sha, head])
    assert.throws(() => f.store.room('r'), /frozen contract/)
  })
})
