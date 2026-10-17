// The reader-local frontier of a removed actor's stream (git/4): closed where this reader stood when it learned of
// the removal, never moved later, and nothing beyond it counted.
import {describe, it} from 'node:test'
import assert from 'node:assert/strict'
import {closeFrontiers, eligible} from '../../main/ts/core/hub/history/retire.ts'
import type {SignalEvent} from '../../main/ts/core/hub/ports/store.ts'

const rec = (actor: string, id: string, parent: string): SignalEvent => ({id, parent, roomGenesis: 'g', control: 'c0', actor, target: 't', signal: 'read'})
const stream = [rec('alice', 'a1', 'g'), rec('alice', 'a2', 'a1'), rec('bob', 'b1', 'g'), rec('alice', 'a3', 'a2')]
const ids = (xs: SignalEvent[]) => xs.map(x => x.id)

describe('retire: a removed actor\'s stream as one reader sees it', () => {
  it('closes at what this reader had accepted when it learned of the removal, and never moves it later', () => {
    const f = closeFrontiers({alice: 'c1'}, {alice: 'a1', bob: 'b1'})
    assert.deepEqual(f, {alice: {control: 'c1', head: 'a1'}})
    assert.deepEqual(closeFrontiers({alice: 'c1'}, {alice: 'a3'}, f), f, 'a later, longer accepted prefix does not reopen it')
  })

  it('counts a removed actor\'s records up to its frontier only, and leaves the others untouched', () => {
    assert.deepEqual(ids(eligible(stream, closeFrontiers({alice: 'c1'}, {alice: 'a2'}))), ['a1', 'a2', 'b1'])
    assert.deepEqual(ids(eligible(stream, {})), ['a1', 'a2', 'b1', 'a3'], 'nobody removed, nothing cut')
  })

  it('counts nothing of a removed actor for a reader that had accepted none of it', () => {
    assert.deepEqual(ids(eligible(stream, closeFrontiers({alice: 'c1'}, {}))), ['b1'])
  })

  it('counts nothing of a removed actor whose accepted head is gone from its stream (that rewrite alarms elsewhere)', () => {
    assert.deepEqual(ids(eligible(stream, {alice: {control: 'c1', head: 'zz'}})), ['b1'])
  })
})
