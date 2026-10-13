// The contract every store type passes (docs/spec/hub-1.md, What a store guarantees), as one suite over a factory of
// fresh stores. A new store type runs it from its own test file; what fails is what it does not yet guarantee.
import {describe, it} from 'node:test'
import type {TestContext} from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {compose} from '../../main/ts/core/hub/protocol/index.ts'
import type {Store, StoredRoom} from '../../main/ts/core/hub/ports/store.ts'

// A fresh store of the type under test in its own directory, and a second handle on the same store (another writer).
export type Fixture = {store: Store, again: () => Store}
export type Factory = (dir: string) => Fixture

const scratch = (t: TestContext): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ringi-store-'))
  t.after(() => fs.rmSync(d, {recursive: true, force: true}))
  return d
}
const roomText = (name: string) => compose(`room ${name}`, [['To', '*'], ['Kind', 'room'], ['Room-Id', crypto.randomBytes(16).toString('hex')]])
// A signed store's room starts with its signers, the root alone, and admits each writer's key.
const control = (s: Store) => ({'ROOM.md': '# r\n', 'members.json': JSON.stringify(s.trust === 'signed' ? {operator: {role: 'root'}} : {operator: {role: 'root'}, alice: {}, bob: {}}) + '\n', 'profile.json': '{}\n',
  ...(s.trust === 'signed' ? {allowed_signers: s.rootRoster!()} : {})})
const say = (subject: string) => compose(subject, [['To', '*']])
const room = (s: Store, name: string): StoredRoom => s.room(name) ?? assert.fail(`room ${name} is not there`)
const texts = (s: Store, r: StoredRoom, who: string) => s.messages(r, who, s.logHead(r, who)!).map(m => m.text.toString('utf8'))

export const storeContract = (type: string, make: Factory): void => { describe(`store contract: ${type}`, () => {
  // A room with alice and bob writing in it.
  const fresh = (t: TestContext) => {
    const f = make(scratch(t)), s = f.store
    s.createRoom('r', 'operator', roomText('r'), control(s))
    if (s.trust === 'signed') for (const who of ['alice', 'bob']) s.admit!(room(s, 'r'), who, s.joinKey!(room(s, 'r'), who).publicKey)
    return f
  }

  it('gives one selected room and control/message ids that do not change', t => {
    const {store} = fresh(t)
    const r = room(store, 'r')
    assert.equal(room(store, 'r').genesis, r.genesis)
    const id = store.append(r, 'alice', say('hello'), [])
    assert.equal(store.logHead(room(store, 'r'), 'alice'), id)
    assert.throws(() => store.createRoom('other', 'operator', roomText('other'), control(store)))
  })

  it('keeps what a message said and who wrote it, however much is written after it', t => {
    const {store} = fresh(t)
    const first = store.append(room(store, 'r'), 'alice', say('first'), [])
    const before = texts(store, room(store, 'r'), 'alice')
    for (const s of ['second', 'third']) store.append(room(store, 'r'), 'alice', say(s), [])
    store.append(room(store, 'r'), 'bob', say('aside'), [])
    const r = room(store, 'r')
    assert.deepEqual(texts(store, r, 'alice').slice(0, before.length), before)
    assert.equal(store.messages(r, 'alice', store.logHead(r, 'alice')!)[0].id, first)
    assert.deepEqual(store.logIds(r).sort(), ['alice', 'bob'])
  })

  it('says whether a log goes on from what a reader accepted', t => {
    const {store} = fresh(t)
    const accepted = store.append(room(store, 'r'), 'alice', say('accepted'), [])
    const later = store.append(room(store, 'r'), 'alice', say('later'), [])
    assert.ok(store.extends(accepted, later))
    assert.ok(store.extends(accepted, accepted))
    assert.ok(!store.extends(later, accepted))
  })

  it('keeps what a reader accepted pinned until it lets go', t => {
    const {store} = fresh(t)
    const id = store.append(room(store, 'r'), 'alice', say('evidence'), [])
    store.pin(room(store, 'r'), 'bob', 'alice', id)
    assert.match(store.messages(room(store, 'r'), 'alice', id)[0].text.toString('utf8'), /^evidence/)
    store.unpin(room(store, 'r'), 'bob', 'alice')
  })

  it('writes a signal once, however often it is written', t => {
    const {store} = fresh(t)
    const id = store.append(room(store, 'r'), 'alice', say('opened'), [])
    for (let i = 0; i < 2; i++) store.signal(room(store, 'r'), 'alice', id, 'opened')
    const mine = store.signals(room(store, 'r')).filter(s => s.actor === 'alice')
    assert.equal(mine.length, 1)
    assert.equal(mine[0].target, id)
  })

  it('lands two writers on one room, neither overwriting the other', t => {
    const {store, again} = fresh(t)
    const other = again()
    // Both read the room before either writes: the second writes on a tip that has moved.
    const mine = room(store, 'r'), theirs = room(other, 'r')
    const a = store.append(mine, 'alice', say('from one'), [])
    const b = other.append(theirs, 'bob', say('from another'), [])
    const r = room(store, 'r')
    assert.equal(store.logHead(r, 'alice'), a)
    assert.equal(store.logHead(r, 'bob'), b)
  })

  it('stores files attached to messages', t => {
    const {store} = fresh(t)
    const file = path.join(scratch(t), 'note.txt')
    fs.writeFileSync(file, 'attached\n')
    const blob = store.blob(file)
    assert.equal(blob.size, 9)
    const id = store.append(room(store, 'r'), 'alice', say('with a file'), [{path: 'files/note.txt', blob: blob.id, mode: '100644'}])
    assert.equal(store.file(id, 'files/note.txt').toString('utf8'), 'attached\n')
    assert.equal(store.sizes(id, ['files/note.txt']).get('files/note.txt'), 9)
    assert.deepEqual(store.messages(room(store, 'r'), 'alice', id)[0].files.map(f => f.path), ['files/note.txt'])
  })

  it('appends telemetry and shows the latest verified facts, if it keeps presence', t => {
    const {store} = fresh(t)
    if (!store.heartbeat || !store.heartbeats) return t.skip(`${type} keeps no presence`)
    const id = store.append(room(store, 'r'), 'alice', say('working'), [])
    store.heartbeat(room(store, 'r'), 'alice', id, 'State: working\nAlive: yes\nNext: 30\n')
    store.heartbeat(room(store, 'r'), 'alice', id, 'State: waiting\nAlive: yes\nNext: 30\n')
    const beats = store.heartbeats(room(store, 'r'))
    assert.equal(beats.length, 1)
    assert.match(beats[0].text, /State: waiting/)
  })
}) }
