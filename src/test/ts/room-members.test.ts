import {describe, it} from 'node:test'
import assert from 'node:assert/strict'
import {membershipAt} from '../../main/ts/core/hub/rooms/room-members.ts'
import type {Store, StoredRoom} from '../../main/ts/core/hub/ports/store.ts'

const room: StoredRoom = {name: 'r', head: 'c1', genesis: 'c0', base: 'base', tip: 'c1',
  control: [{rev: 'c0', text: 'room r'}, {rev: 'c1', text: 'remove alice'}]}
const fixture = (texts: Record<string, string>) => {
  const calls: string[] = []
  const store: Pick<Store, 'controlFile'> = {controlFile: (_room, name, rev) => {
    assert.equal(name, 'members.json'); calls.push(rev!)
    return texts[rev!] ?? null
  }}
  return {store, calls}
}
const root = {operator: {role: 'root'}}

describe('membership at an accepted control', () => {
  it('keeps the git/3 meaning, including an actor named retired', () => {
    const active = {...root, retired: {since: 'old'}}
    const f = fixture({c0: JSON.stringify(active)})
    assert.deepEqual(membershipAt(f.store, room, 'git/3')('c0'), active)
  })

  it('reads git/4 historical members and caches immutable snapshots separately by revision', () => {
    const before = {...root, alice: {role: 'member'}, retired: {role: 'member'}}
    const f = fixture({
      c0: JSON.stringify({members: before, retired: {}}),
      c1: JSON.stringify({members: {...root, retired: {role: 'member'}}, retired: {alice: {key: null, since: 'later'}}}),
    })
    const at = membershipAt(f.store, room, 'git/4'), first = at('c0')
    assert.deepEqual(first, before)
    assert.equal(at('c1').alice, undefined)
    assert.equal(at('c0'), first)
    assert.deepEqual(f.calls, ['c0', 'c1'])
    assert.throws(() => { first.alice.role = 'root' }, TypeError)
    assert.throws(() => Object.defineProperty(first, 'eve', {value: {}}), TypeError)
    assert.equal(at('c0').alice.role, 'member')
  })

  it('refuses unknown or foreign controls before reading any file', () => {
    const f = fixture({outside: JSON.stringify({members: root, retired: {}})})
    assert.throws(() => membershipAt(f.store, room, 'git/4')('outside'), /not an accepted control/)
    assert.deepEqual(f.calls, [])
  })

  it('does not infer the wire layout from a JSON field or silently accept malformed membership', () => {
    for (const value of [root, {members: root}, {members: root, retired: []}, {members: [], retired: {}},
      {members: {alice: {role: 1}}, retired: {}}, {members: {alice: {}}, retired: {alice: {key: null, since: 'x'}}}]) {
      const f = fixture({c0: JSON.stringify(value)})
      assert.throws(() => membershipAt(f.store, room, 'git/4')('c0'), /members|member|retired/)
    }
    const f = fixture({c0: JSON.stringify(root)})
    assert.throws(() => membershipAt(f.store, room, 'git/99')('c0'), /unsupported membership layout/)
  })

  it('fails closed on missing files, invalid JSON and duplicate fields', () => {
    for (const text of [undefined, '{broken', '{"members":{},"retired":{},"members":{}}']) {
      const f = fixture(text === undefined ? {} : {c0: text})
      assert.throws(() => membershipAt(f.store, room, 'git/4')('c0'))
    }
  })
})
