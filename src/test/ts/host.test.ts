// ProcessHost contracts: alternate facts reach heartbeat/session, launches settle, and an observation timeout does
// not spend authority to stop a process. Existing heartbeat/runtime tests retain their compatibility coverage.

import {describe, it} from 'node:test'
import assert from 'node:assert/strict'
import '../../main/ts/composition/index.ts'
import {hostPosix} from '../../main/ts/adapters/host-posix/index.ts'
import {agentPorts, wireAgents} from '../../main/ts/core/agents/ports/index.ts'
import {probe} from '../../main/ts/core/agents/heartbeat/index.ts'
import {pidAlive} from '../../main/ts/core/agents/sessions/index.ts'
import {hubPorts, wireHub} from '../../main/ts/core/hub/ports/index.ts'
import {claim, release} from '../../main/ts/core/agents/heartbeat/singleton.ts'

describe('ProcessHost', () => {
  it('uses the chosen host for heartbeat and session facts without an OS probe', t => {
    const original = agentPorts()
    t.after(() => wireAgents(original))
    const host = {...original.host,
      clock: {wall: () => 1000000, monotonic: () => 10},
      snapshot: () => null,
      alive: () => false,
      inspect: () => ({alive: false, cpu: 4.5}),
    }
    wireAgents({...original, host})
    const f = probe({handle: 'env:host-contract', product: 'watch', pid: 123, lastSeen: '1970-01-01T00:00:00Z', state: 'active'})
    assert.equal(f.at, 1000)
    assert.equal(f.alive, false)
    assert.equal(f.cpu, 4.5)
    assert.equal(pidAlive(123), false)
  })

  it('keeps shell exit results and isolates handle ownership', async () => {
    const host = hostPosix(), other = hostPosix()
    const process = host.start({shell: 'exit 7', timeout: null, env: globalThis.process.env})
    assert.throws(() => other.stop(process), /belongs to another host/)
    const result = await host.awaitQuiescence(process, host.clock.monotonic() + 5000)
    assert.ok(result)
    assert.equal(result.code, 7)
    assert.equal(result.timedOut, false)
  })

  it('returns at an observation deadline while the process finishes normally', async () => {
    const host = hostPosix()
    const process = host.start({shell: 'sleep 0.2; exit 0', timeout: null, env: globalThis.process.env})
    assert.equal(await host.awaitQuiescence(process, host.clock.monotonic() + 5), null)
    const result = await host.awaitQuiescence(process, host.clock.monotonic() + 5000)
    assert.ok(result)
    assert.equal(result.code, 0)
    assert.equal(result.timedOut, false)
  })

  it('rejects corrupt JSON owners while retaining a valid legacy pulse PID', t => {
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
