// ProcessHost: the host composition chose is what heartbeat and sessions ask, and the pulse is one per machine.

import {describe, it} from 'node:test'
import assert from 'node:assert/strict'
import '../../main/ts/composition/index.ts'
import {agentPorts, wireAgents} from '../../main/ts/core/agents/ports/index.ts'
import {probe} from '../../main/ts/core/agents/heartbeat/index.ts'
import {pidAlive} from '../../main/ts/core/agents/sessions/index.ts'
import {hubPorts, wireHub} from '../../main/ts/core/hub/ports/index.ts'
import {claim, release} from '../../main/ts/core/agents/heartbeat/singleton.ts'

describe('ProcessHost', () => {
  it('uses the chosen host for heartbeat and session facts without an OS probe', t => {
    const original = agentPorts()
    t.after(() => wireAgents(original))
    wireAgents({...original, host: {...original.host, supported: true, alive: () => false}})
    const f = probe({handle: 'env:host-contract', product: null, pid: 123, lastSeen: '1970-01-01T00:00:00Z', state: 'active'})
    assert.equal(f.alive, false)
    assert.equal(pidAlive(123), false)
  })

  it('rejects corrupt pulse records and keeps a valid owner', t => {
    const agents = agentPorts(), hub = hubPorts()
    t.after(() => { wireAgents(agents); wireHub(hub) })
    let record: unknown
    const state = {...hub.state,
      locked: <T>(_name: string, fn: () => T): T => fn(),
      read: <T>(_key: readonly string[], fallback: T): T => (record ?? fallback) as T,
      write: (_key: readonly string[], value: unknown) => { record = value },
      remove: () => { record = undefined },
    }
    wireHub({...hub, state})
    wireAgents({...agents, host: {...agents.host, alive: () => true}})
    const owner = process.pid + 1
    for (const value of [true, String(owner), [owner], 0, -1, 1.5]) {
      record = value
      assert.equal(claim(), null)
      assert.equal(record, process.pid)
      release()
      assert.equal(record, undefined)
    }
    record = owner
    assert.equal(claim(), owner)
    release()
    assert.equal(record, owner, 'release does not erase another owner')
  })
})
