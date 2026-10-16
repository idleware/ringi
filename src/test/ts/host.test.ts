// ProcessHost: the host composition chose is what sessions ask.

import {describe, it} from 'node:test'
import assert from 'node:assert/strict'
import '../../main/ts/composition/index.ts'
import {agentPorts, wireAgents} from '../../main/ts/core/agents/ports/index.ts'
import {pidAlive} from '../../main/ts/core/agents/sessions/index.ts'

describe('ProcessHost', () => {
  it('uses the chosen host for session facts without an OS probe', t => {
    const original = agentPorts()
    t.after(() => wireAgents(original))
    wireAgents({...original, host: {...original.host, supported: true, alive: () => false}})
    assert.equal(pidAlive(123), false)
  })
})
