import {describe, it} from 'node:test'
import type {TestContext} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import {GitStore} from '../../main/ts/adapters/store-git/index.ts'
import {init} from '../../main/ts/adapters/store-git/repo.ts'
import {keysFile} from '../../main/ts/adapters/keys-file/index.ts'
import {git, ident} from '../../main/ts/adapters/store-git/remote/git.ts'
import {identityKey, signerLine} from '../../main/ts/adapters/store-git/remote/keys.ts'
import {signCommit} from '../../main/ts/adapters/store-git/signing.ts'
import {treeWith} from '../../main/ts/adapters/store-git/remote/admit.ts'
import {membershipFile, membershipText} from '../../main/ts/adapters/store-git/remote/membership.ts'
import type {Membership} from '../../main/ts/adapters/store-git/remote/membership.ts'
import {membershipChange} from '../../main/ts/adapters/store-git/remote/membership-change.ts'
import type {Descriptor, RoomEndpointV2} from '../../main/ts/core/hub/ports/store.ts'
import type {SigningContext} from '../../main/ts/core/signing/index.ts'

const root = {operator: {role: 'root'}}, fp = 'SHA256:' + 'a'.repeat(43)
const state = (members: Membership['members'] = root, retired: Membership['retired'] = {}): Membership => ({members, retired})
const fixture = (t: TestContext, layout: 'git/3' | 'git/4' = 'git/4') => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ringi-git4-'))
  t.after(() => fs.rmSync(home, {recursive: true, force: true}))
  const custody = keysFile(home), refs: string[] = []
  let denied = false
  const signing: SigningContext = {resolve(hub, actor, create) {
    assert.equal(actor, 'operator', 'git/4 actor must not fall back to a legacy hub/actor key')
    return custody.resolve(hub, actor, create)
  }, resolveRef(ref, create) { refs.push(ref); return custody.resolveRef!(ref, create) }, signer: {
    publicIdentity: custody.signer.publicIdentity,
    sign(request) { if (denied) throw Error('fixture signer denied'); return custody.signer.sign(request) },
  }}
  const d: Descriptor = {schema: 'ringi-hub/3', name: 'test', trust: 'signed', genesis: '', store: {type: 'git'}, contract: {path: 'contract'}}
  const sourceAt = path.join(home, 'source')
  GitStore.rootFor(sourceAt, d, home, signing)
  const source = GitStore.create(sourceAt, d, {home, signing, layout: 'git/4'}, {
    'contract.json': JSON.stringify({schema: 'ringi-hub', version: '2.0', protocol: 1, store: layout, trust: 'signed', root: d.root}),
  }, 'hub fixture\n\nTo: *\nKind: hub\n')
  const at = path.join(home, 'room'), dir = path.join(at, 'store', '.git')
  fs.mkdirSync(path.dirname(dir), {recursive: true}); init(dir, home)
  const endpoint: RoomEndpointV2 = {schema: 'ringi-room/2', address: 'local://r', name: 'r', hubGenesis: d.genesis, genesis: '', trust: 'signed', root: d.root,
    location: {directory: {path: at, identity: 'fixture'}, generation: 'fixture-1'}, store: {path: 'store'}}
  const store = new GitStore(at, d, home, {signing, layout: 'git/4'}, endpoint)
  store.seedContract(source)
  store.createRoom('r', 'operator', 'room r\n\nTo: *\nKind: room\n', {'members.json': membershipText(state(), 'git/4'), allowed_signers: store.rootRoster(), 'profile.json': '{}', 'ROOM.md': '# r'})
  const select = (actor: string) => { endpoint.keyRef = `ringi-key:realm/${'1'.repeat(64)}/${actor}`; return identityKey(store.h, actor, true) }
  const hashes = () => git(store.h, ['for-each-ref', '--format=%(refname) %(objectname)'])
  return {home, store, endpoint, select, hashes, refs, deny: (value: boolean) => { denied = value }}
}

describe('git/4 membership policy', () => {
  it('distinguishes the explicit envelope from git/3 and validates terminal actor/key shape', () => {
    assert.deepEqual(membershipFile(JSON.stringify({...root, retired: {}}), 'git/3', true).members, {...root, retired: {}})
    const good = state(root, {alice: {key: fp, since: 'removed'}})
    assert.deepEqual(membershipFile(JSON.stringify(good), 'git/4', true), good)
    for (const bad of [root, {members: root}, {...good, extra: {}}, state({...root, alice: {role: 'member'}}, good.retired),
      state(root, {alice: {key: null, since: 'removed'}}), state(root, {operator: {key: fp, since: 'removed'}}),
      state(root, {alice: {key: fp, since: ''}}), state(root, {'alice.dot': {key: fp, since: 'removed'}})]) {
      assert.throws(() => membershipFile(JSON.stringify(bad), 'git/4', true))
    }
    assert.throws(() => membershipFile('{"members":{},"retired":{},"retired":{}}', 'git/4', true), /duplicate/)
    assert.deepEqual(membershipFile(JSON.stringify(state(root, {alice: {key: null, since: 'removed'}})), 'git/4', false).retired.alice.key, null)
    assert.throws(() => membershipFile(JSON.stringify(good), 'git/99' as never, true), /unsupported/)
  })
  it('requires an explicit removal and preserves immutable tombstones and retained keys', () => {
    const key = {line: 'fixture-key', fp}, before = {...state({...root, alice: {role: 'member'}}), entries: [{principal: 'alice', key}]}
    const after = {...state(root, {alice: {key: fp, since: 'removed'}}), entries: []}
    assert.deepEqual(membershipChange(before, after, 'remove alice', true), ['alice'])
    assert.throws(() => membershipChange(before, after, 'edit', true), /explicit remove/)
    assert.throws(() => membershipChange(after, {...after, retired: {}}, 'edit', true), /immutable/)
    assert.throws(() => membershipChange(after, {...after, retired: {alice: {key: fp, since: 'changed'}}}, 'edit', true), /immutable/)
    assert.throws(() => membershipChange(before, {...after, retired: {alice: {key: 'other', since: 'removed'}}}, 'remove alice', true), /exact previous fingerprint/)
    assert.throws(() => membershipChange(before, {...before, entries: [{principal: 'alice', key: {...key, line: 'rotated'}}]}, 'edit', true), /cannot change/)
    assert.throws(() => membershipChange({...state(), entries: []}, after, 'room r', true, true), /preexisting retirements/)
  })
})

describe('signed git/4 control validation on disposable repositories', () => {
  it('removes one member under the pinned root, preserves history and returns its first verified retirement', t => {
    const f = fixture(t), alice = f.select('alice')
    f.store.admit(f.store.room('r')!, 'alice', alice.line)
    let r = f.store.room('r')!
    const task = f.store.append(r, 'alice', 'before removal\n\nTo: operator\nKind: task\n', [])
    f.store.signal(r, 'alice', task, 'opened')
    r = f.store.room('r')!
    const stream = f.store.signalHeads(r)[0].head
    assert.deepEqual(f.store.retirements(r), {})
    const beforeRemoval = r
    f.endpoint.keyRef = 'unavailable:actor-key-is-not-root-authority'
    const removed = f.store.remove(r, 'operator', 'alice')
    r = f.store.room('r')!
    assert.deepEqual(f.store.retirements(r), {alice: removed})
    assert.equal(f.store.roster(r)!.members.alice, undefined)
    assert.equal(f.store.verifyLog(r, 'alice', task), null, 'removal does not invalidate an already admitted historical message')
    const body = membershipFile(f.store.controlFile(r, 'members.json')!, 'git/4', true)
    assert.equal(body.retired.alice.key, alice.fp)
    assert.equal(f.store.controlFile(r, 'allowed_signers')!.includes('alice '), false)
    const refs = f.hashes()
    assert.equal(f.store.remove(r, 'operator', 'alice'), removed)
    assert.equal(f.hashes(), refs)
    assert.throws(() => f.store.append(r, 'alice', 'late\n\nTo: operator\n', []), /not active|retired/)
    assert.throws(() => f.store.signal(r, 'alice', task, 'taken'), /not active|retired/)
    assert.throws(() => f.store.joinKey(r, 'alice'), /retired/)
    assert.throws(() => f.store.joinKey(beforeRemoval, 'alice'), /retired/, 'stale Room cannot recreate a terminal actor identity')
    assert.deepEqual(f.store.retirements(beforeRemoval), {}, 'facts remain bounded by the requested accepted control snapshot')
    assert.equal(f.hashes(), refs)
    f.store.signal(r, 'alice', task, 'opened')
    assert.equal(f.store.signalHeads(r)[0].head, stream, 'exact retained tuple can retry publication without a new record')
  })
  it('refuses retired actor names and fingerprints, root removal and non-root authority without moving refs', t => {
    const f = fixture(t), alice = f.select('alice')
    f.store.admit(f.store.room('r')!, 'alice', alice.line)
    f.store.remove(f.store.room('r')!, 'operator', 'alice')
    const r = f.store.room('r')!, refs = f.hashes(), replacement = f.select('replacement')
    for (const [who, key] of [['alice', alice.line], ['alice', replacement.line], ['bob', alice.line]]) assert.throws(() => f.store.admit(r, who, key), /retired/)
    assert.throws(() => f.store.remove(r, 'alice', 'operator'), /root/)
    assert.throws(() => f.store.remove(r, 'operator', 'operator'), /root/)
    assert.equal(f.hashes(), refs)
    f.store.admit(r, 'alice-2', replacement.line)
    assert.equal(f.store.retirements(f.store.room('r')!).alice, r.head)
  })
  it('uses the explicit actor keyRef, refuses wrong/unknown refs before append, and keeps root signing separate', t => {
    const f = fixture(t), alice = f.select('alice')
    const admitted = f.store.admit(f.store.room('r')!, 'alice', alice.line)
    assert.equal(f.store.admit(f.store.room('r')!, 'alice', alice.line), admitted, 'matching admission retry makes no new control')
    f.select('bob')
    const r = f.store.room('r')!, refs = f.hashes()
    assert.throws(() => f.store.append(r, 'alice', 'wrong key\n\nTo: operator\n', []), /does not match/)
    f.endpoint.keyRef = 'unsupported:no-fallback'
    assert.throws(() => f.store.append(r, 'alice', 'unknown key\n\nTo: operator\n', []), /ref|reference/i)
    assert.equal(f.hashes(), refs)
    const removed = f.store.remove(r, 'operator', 'alice')
    assert.equal(f.store.retirements(f.store.room('r')!).alice, removed)
  })
  it('does not mutate refs when the root signer refuses a removal', t => {
    const f = fixture(t), alice = f.select('alice')
    f.store.admit(f.store.room('r')!, 'alice', alice.line)
    const r = f.store.room('r')!, refs = f.hashes()
    f.deny(true)
    assert.throws(() => f.store.remove(r, 'operator', 'alice'), /fixture signer denied/)
    assert.equal(f.hashes(), refs)
    assert.deepEqual(f.store.retirements(r), {})
  })
  it('refuses a root-signed attempt to erase accepted tombstones instead of reporting it as an accepted control', t => {
    const f = fixture(t), alice = f.select('alice')
    f.store.admit(f.store.room('r')!, 'alice', alice.line)
    f.store.remove(f.store.room('r')!, 'operator', 'alice')
    const r = f.store.room('r')!, tip = f.store.rev('refs/heads/chat')!
    const tree = treeWith(f.store.h, tip, r.head, {'members.json': membershipText(state(), 'git/4')})
    const raw = git(f.store.h, ['commit-tree', tree, '-p', tip], {input: 'edit\n\nTo: *\nKind: room\n', env: ident('operator')}).trim()
    const forged = signCommit(f.store.h, 'operator', raw)
    git(f.store.h, ['update-ref', 'refs/heads/chat', forged, tip])
    assert.throws(() => f.store.room('r'), /immutable/)
  })
  it('requires endpoint/2 plus explicit git/4 and a frozen git/4 contract; no layout is guessed', t => {
    const f = fixture(t)
    assert.throws(() => new GitStore(f.endpoint.location.directory.path, f.store.d, f.home, {}, f.endpoint), /layout disagree/)
    assert.throws(() => new GitStore(f.endpoint.location.directory.path, f.store.d, f.home, {layout: 'git/99' as never}, f.endpoint), /unsupported/)
    assert.throws(() => new GitStore(f.endpoint.location.directory.path, {...f.store.d, trust: 'asserted'}, f.home, {layout: 'git/4'}, {...f.endpoint, trust: 'asserted'}), /asserted git\/4 cannot declare a signing root/)
    assert.throws(() => fixture(t, 'git/3'), /explicit git\/4 frozen contract/)
  })
  it('requires an own member entry even when the principal is named constructor', t => {
    const f = fixture(t), key = f.select('constructor'), r = f.store.room('r')!, tip = f.store.rev('refs/heads/chat')!
    const tree = treeWith(f.store.h, tip, r.head, {allowed_signers: f.store.rootRoster() + signerLine('constructor', key)})
    const raw = git(f.store.h, ['commit-tree', tree, '-p', tip], {input: 'admit constructor\n\nTo: *\nKind: room\n', env: ident('operator')}).trim()
    git(f.store.h, ['update-ref', 'refs/heads/chat', signCommit(f.store.h, 'operator', raw), tip])
    assert.throws(() => f.store.room('r'), /disagree/)
  })
})


describe('retired signal tails and retained evidence', () => {
  const rawSignal = (f: ReturnType<typeof fixture>, parent: string, body: string, signed = true) => {
    const raw = git(f.store.h, ['commit-tree', git(f.store.h, ['rev-parse', `${parent}^{tree}`]).trim(), '-p', parent], {input: body, env: ident('alice')}).trim()
    const sha = signed ? signCommit(f.store.h, 'alice', raw) : raw
    git(f.store.h, ['update-ref', 'refs/heads/alice/signals', sha])
    return sha
  }
  it('ignores new invalid suffixes only after retirement; retained tuples and reader pins survive restart', t => {
    const f = fixture(t), alice = f.select('alice')
    f.store.admit(f.store.room('r')!, 'alice', alice.line)
    const before = f.store.room('r')!, task = f.store.append(before, 'alice', 'task\n\nTo: operator\nKind: task\n', [])
    f.store.signal(before, 'alice', task, 'opened')
    const first = f.store.signalHeads(before)[0].head
    f.store.pinSignals(before, 'reader', 'alice', first)
    const after = f.store.remove(before, 'operator', 'alice'), r = f.store.room('r')!
    const bodies = ['broken facts\n', `Room: ${r.genesis}\nControl: ${after}\nTarget: ${task}\nSignal: read\n`,
      `Room: ${r.genesis}\nControl: ${before.head}\nTarget: ${task}\nSignal: read\n`]
    for (const [i, body] of bodies.entries()) {
      rawSignal(f, first, body, i !== 2)
      const reopened = new GitStore(f.endpoint.location.directory.path, f.store.d, f.home, {signing: f.store.h.signing, layout: 'git/4'}, f.endpoint)
      assert.deepEqual(reopened.signals(r).map(x => x.id), [first])
      assert.deepEqual(reopened.alarms(r), [])
      assert.equal(reopened.rev(`refs/ringi/accepted/${r.genesis}/reader/signals/alice`), first)
    }
    // An already valid tuple can still retry after restart, with no replacement commit.
    git(f.store.h, ['update-ref', 'refs/heads/alice/signals', first])
    const reopened = new GitStore(f.endpoint.location.directory.path, f.store.d, f.home, {signing: f.store.h.signing, layout: 'git/4'}, f.endpoint)
    reopened.signal(r, 'alice', task, 'opened')
    assert.equal(reopened.signalHeads(r)[0].head, first)
  })
  it('does not hide bad records in an active stream, or accepted rewrites/truncation/deletion after removal', t => {
    const f = fixture(t), alice = f.select('alice')
    f.store.admit(f.store.room('r')!, 'alice', alice.line)
    const before = f.store.room('r')!, task = f.store.append(before, 'alice', 'task\n\nTo: operator\nKind: task\n', [])
    f.store.signal(before, 'alice', task, 'opened')
    const first = f.store.signalHeads(before)[0].head
    rawSignal(f, first, 'bad active facts\n')
    assert.deepEqual(f.store.signals(before).map(x => x.id), [first])
    assert.match(f.store.alarms(before).join(' '), /only facts/)
    git(f.store.h, ['update-ref', 'refs/heads/alice/signals', first])
    f.store.pinSignals(before, 'reader', 'alice', first)
    f.store.signal(before, 'operator', task, 'read')
    const other = f.store.signalHeads(before).find(s => s.actor === 'operator')!.head
    f.store.remove(before, 'operator', 'alice')
    const r = f.store.room('r')!
    const fork = rawSignal(f, r.genesis, 'retired invalid alternate history\n')
    assert.notEqual(fork, first)
    assert.deepEqual(f.store.signals(r).map(x => x.id), [other])
    assert.match(f.store.alarms(r).join(' '), new RegExp(`signal stream alice does not include its accepted prefix ${first}`))
    assert.equal(f.store.rev(`refs/ringi/accepted/${r.genesis}/reader/signals/alice`), first)
    git(f.store.h, ['update-ref', 'refs/heads/alice/signals', r.genesis])
    const reopened = new GitStore(f.endpoint.location.directory.path, f.store.d, f.home, {signing: f.store.h.signing, layout: 'git/4'}, f.endpoint)
    assert.deepEqual(reopened.signals(r).map(x => x.id), [other])
    assert.match(reopened.alarms(r).join(' '), new RegExp(`signal stream alice does not include its accepted prefix ${first}`))
    assert.throws(() => reopened.signal(r, 'alice', task, 'opened'), /accepted prefix/)
    git(f.store.h, ['update-ref', '-d', 'refs/heads/alice/signals'])
    f.store.signals(r)
    assert.match(f.store.alarms(r).join(' '), /removed after it was accepted/)
  })
  it('never waives a record retained as accepted evidence even if its content is invalid', t => {
    const f = fixture(t), alice = f.select('alice')
    f.store.admit(f.store.room('r')!, 'alice', alice.line)
    const before = f.store.room('r')!
    const bad = rawSignal(f, before.genesis, 'invalid pinned facts\n')
    f.store.pinSignals(before, 'reader', 'alice', bad)
    f.store.remove(before, 'operator', 'alice')
    const r = f.store.room('r')!
    assert.deepEqual(f.store.signals(r), [])
    assert.match(f.store.alarms(r).join(' '), new RegExp(`signal stream alice does not include its accepted prefix ${bad}`))
    assert.equal(f.store.rev(`refs/ringi/accepted/${r.genesis}/reader/signals/alice`), bad)
  })
  it('syncs a retired invalid tail without promoting it, but quarantines an accepted remote rewrite', t => {
    const f = fixture(t), alice = f.select('alice')
    f.store.admit(f.store.room('r')!, 'alice', alice.line)
    const before = f.store.room('r')!, task = f.store.append(before, 'alice', 'task\n\nTo: operator\nKind: task\n', [])
    f.store.signal(before, 'alice', task, 'opened')
    const first = f.store.signalHeads(before)[0].head, origin = path.join(f.home, 'origin.git')
    git(f.store.h, ['init', '-q', '--bare', '-b', 'main', origin])
    git(f.store.h, ['push', '-q', origin, 'refs/heads/main', 'refs/heads/chat', 'refs/heads/alice/signals'])
    f.endpoint.store.remote = 'git+' + pathToFileURL(origin).href
    f.store.sync()
    assert.equal(f.store.rev('refs/ringi/remote-accepted/alice/signals'), first)
    f.store.remove(f.store.room('r')!, 'operator', 'alice')
    const r = f.store.room('r')!, bad = rawSignal(f, first, 'new retired garbage\n')
    git(f.store.h, ['push', '-q', origin, `${bad}:refs/heads/alice/signals`])
    f.store.sync()
    assert.deepEqual(f.store.h.remoteAlarms, {})
    assert.equal(f.store.rev('refs/ringi/remote-accepted/alice/signals'), first)
    assert.deepEqual(f.store.signals(r).map(x => x.id), [first])
    assert.deepEqual(f.store.alarms(r), [])
    const fork = rawSignal(f, r.genesis, 'alternate retired history\n')
    git(f.store.h, ['push', '-q', '--force', origin, `${fork}:refs/heads/alice/signals`])
    f.store.sync()
    assert.match(f.store.h.remoteAlarms!['refs/heads/alice/signals'], /accepted prefix/)
    assert.equal(f.store.rev('refs/ringi/remote-accepted/alice/signals'), first)
  })
})
