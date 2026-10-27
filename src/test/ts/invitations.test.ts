// The root's own list of invitees (E8): actor ids never reused, one active actor per account, and a removal that
// must finish before the account comes back and never revokes a newer actor's rights.
import {describe, it} from 'node:test'
import assert from 'node:assert/strict'
import '../../main/ts/composition/index.ts'
import {hubPorts, wireHub} from '../../main/ts/core/hub/ports/index.ts'
import {addInvitation, inviteRefusal, loadInvitations, nextActor, staleRemoval, updateInvitation} from '../../main/ts/core/hub/usecases/invitations.ts'
import type {Invitation} from '../../main/ts/core/hub/usecases/invitations.ts'
import {AGENT_RE} from '../../main/ts/core/hub/protocol/index.ts'
import {inviteV3, keyRefFor, readInvite} from '../../main/ts/core/hub/usecases/invite.ts'

const valid = (id: string) => AGENT_RE.test(id)
const alice = {realm: 'forgejo:forge.example:443', principal: {id: '7', login: 'Alice'}}
const entry = (actor: string, state: Invitation['state'], removal?: Invitation['removal']): Invitation =>
  ({invitation: `i-${actor}`, mode: 'account', ...alice, actor, state, address: 'forgejo://forge.example/team/fix', genesis: 'g', ...(removal ? {removal} : {})})

describe('invitations: the root\'s list', () => {
  it('names a new actor after its login, then the first unused suffix, never a retired or reserved one', () => {
    assert.equal(nextActor(alice.principal, new Set(), valid), 'alice')
    assert.equal(nextActor(alice.principal, new Set(['alice', 'alice-2']), valid), 'alice-3')
    assert.throws(() => nextActor({id: null, login: 'operator'}, new Set(), valid), /cannot name an actor/)
    assert.throws(() => nextActor({id: null, login: 'a.b'}, new Set(), valid), /cannot name an actor/)
  })

  it('invites an account once at a time, and only after its removal finished', () => {
    assert.equal(inviteRefusal([], alice), null)
    assert.match(inviteRefusal([entry('alice', 'admitted')], alice)!, /already/)
    assert.match(inviteRefusal([entry('alice', 'removed', {control: 'c1', medium: 'pending'})], alice)!, /not finished/)
    assert.equal(inviteRefusal([entry('alice', 'removed', {control: 'c1', medium: 'done'})], alice), null)
    assert.equal(inviteRefusal([entry('alice', 'admitted')], {...alice, principal: {id: '8', login: 'alice'}}), null, 'another account of the same login is another invitee')
  })

  it('stops an old removal\'s retry while a newer actor of the same account is active', () => {
    const list = [entry('alice', 'removed', {control: 'c1', medium: 'done'}), entry('alice-2', 'admitted')]
    assert.match(staleRemoval(list, 'alice')!, /stale: alice-2 holds the same account's rights/)
    assert.equal(staleRemoval([entry('alice', 'removed', {control: 'c1', medium: 'pending'})], 'alice'), null)
  })

  it('keeps the list beside the room\'s registration, refusing a second active entry and an actor id used before', t => {
    const hub = hubPorts(), kept = new Map<string, unknown>()
    t.after(() => wireHub(hub))
    wireHub({...hub, state: {...hub.state,
      read: <T>(key: readonly string[], fallback: T): T => (kept.get(key.join('/')) ?? fallback) as T,
      write: (key: readonly string[], value: unknown) => { kept.set(key.join('/'), value) }}})
    const id = 'f'.repeat(64) as Parameters<typeof loadInvitations>[0]
    assert.deepEqual(loadInvitations(id).entries, [])
    addInvitation(id, entry('alice', 'invited'))
    assert.throws(() => addInvitation(id, {...entry('alice', 'invited'), invitation: 'i-2'}), /already/)
    updateInvitation(id, 'alice', e => ({...e, state: 'removed', removal: {control: 'c1', medium: 'done'}}))
    assert.throws(() => addInvitation(id, entry('alice', 'invited')), /was an actor of this room already/, 'a retired id is never given again')
    addInvitation(id, entry('alice-2', 'invited'))
    assert.deepEqual(loadInvitations(id).entries.map(e => [e.actor, e.state]), [['alice', 'removed'], ['alice-2', 'invited']])
    assert.throws(() => updateInvitation(id, 'bob', e => e), /never invited/)
  })

  it('writes ringi-invite/3 with whom it routes to, reads it back, and refuses an older or tampered one by name', () => {
    const oid = 'a'.repeat(40)
    const fields = {mode: 'account' as const, room: 'fix', address: 'forgejo://forge.example/team/fix', locator: 'git+ssh://forgejo@forge.example:2222/team/fix.git',
      genesis: oid, hubGenesis: oid, trust: 'signed' as const, root: 'ssh-ed25519 AAAA', principal: {realm: 'forgejo:forge.example:443', id: '7', login: 'alice'},
      actor: 'alice', invitation: 'i-1'}
    const line = inviteV3(fields)
    assert.deepEqual(readInvite(line), {schema: 'ringi-invite/3', ...fields})
    assert.equal(readInvite('fix'), null, 'a name is no invitation')
    const tampered = 'ringi:' + Buffer.from(JSON.stringify({schema: 'ringi-invite/3', ...fields, locator: 'git+ssh://u:secret@forge.example/team/fix.git'})).toString('base64url')
    assert.throws(() => readInvite(tampered), /malformed/)
    for (const locator of ['git+https://claude:t0k3n@forge.example/team/fix.git', 'git+https://t0k3n@forge.example/team/fix.git'])
      assert.throws(() => inviteV3({...fields, locator}), /carries credentials/)
    for (const x of [null, 'text', []]) assert.throws(() => readInvite('ringi:' + Buffer.from(JSON.stringify(x)).toString('base64url')), /not one ringi reads/)
    const old = 'ringi:' + Buffer.from(JSON.stringify({schema: 'ringi-invite/2'})).toString('base64url')
    assert.throws(() => readInvite(old), /is ringi-invite\/2; this ringi reads ringi-invite\/3/)
    assert.throws(() => inviteV3({...fields, actor: 'Alice'}), /no invitation can be made/)
    assert.throws(() => readInvite('ringi:' + 'A'.repeat(20000)), /longer than any ringi makes/)
  })

  it('picks the joiner\'s key: the realm\'s for an account\'s first actor, a room key for a returning one or a deploy key', () => {
    const oid = 'b'.repeat(40)
    const base = {schema: 'ringi-invite/3' as const, mode: 'account' as const, room: 'fix', address: 'forgejo://forge.example/team/fix', locator: 'git+ssh://f@forge.example/team/fix.git',
      genesis: oid, hubGenesis: oid, trust: 'signed' as const, root: 'k', principal: {realm: 'forgejo:forge.example:443', id: '7', login: 'Alice'}, actor: 'alice', invitation: 'i'}
    const realmKey = keyRefFor(base)
    assert.match(realmKey, /^ringi-key:realm\/[0-9a-f]{32}\/alice$/)
    assert.equal(keyRefFor({...base, address: 'forgejo://forge.example/team/other'}), realmKey, 'one key per machine and account realm, across its rooms')
    assert.match(keyRefFor({...base, actor: 'alice-2'}), /^ringi-key:room\/[0-9a-f]{32}\/alice-2$/)
    assert.notEqual(keyRefFor({...base, actor: 'alice-2'}), keyRefFor({...base, actor: 'alice-2', genesis: 'c'.repeat(40)}), 'a room key belongs to one room incarnation')
    assert.match(keyRefFor({...base, mode: 'deploy-key', principal: {label: 'claude'}, actor: 'claude'}), /^ringi-key:room\//)
    assert.equal(keyRefFor(base, '/keys/mine'), 'file:/keys/mine')
    assert.throws(() => keyRefFor(base, 'mine'), /absolute path/)
  })
})
