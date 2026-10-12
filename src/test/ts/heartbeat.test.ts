// The heartbeat domain: facts a machine shows about an agent, and the judgement made of them, without the model.
import {describe, it} from 'node:test'
import type {TestContext} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import '../../main/ts/composition/index.ts'
import {body, judge, probe} from '../../main/ts/core/agents/heartbeat/index.ts'
import type {Facts} from '../../main/ts/core/agents/heartbeat/index.ts'
import {agentPorts} from '../../main/ts/core/agents/ports/index.ts'
import {toolOf, traceTime} from '../../main/ts/core/agents/heartbeat/tools.ts'

const SUPPORTED = agentPorts().host.supported
const facts = (o: Partial<Facts> = {}): Facts => ({at: 1000, alive: true, trace: null, seen: 0, stopped: false, waits: null, ...o})
const scratch = (t: TestContext): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ringi-heartbeat-'))
  t.after(() => fs.rmSync(d, {recursive: true, force: true}))
  return d
}

describe('heartbeat', () => {
  it('judges working, waiting and gone from facts alone', () => {
    assert.equal(judge(facts({seen: 990})).state, 'working')
    assert.deepEqual([judge(facts({seen: 0})).state, judge(facts({seen: 0})).waits], ['waiting', 'inbox'])
    // A fresh trace of the tool counts as much as a ringi command.
    assert.equal(judge(facts({seen: 0, trace: 950})).state, 'working')
    assert.deepEqual([judge(facts({stopped: true, seen: 999})).waits, judge(facts({waits: 'quorum', seen: 999})).waits], ['stopped', 'quorum'])
    assert.equal(judge(facts({alive: false, seen: 999})).state, 'gone')
    assert.equal(body(judge(facts({seen: 958}), {next: 15})), 'State: working\nAlive: yes\nQuiet: 42\nNext: 15\n')
    assert.equal(body(judge(facts({alive: null}))), 'State: waiting\nWaits: inbox\nAlive: unknown\nQuiet: 1000\nNext: 30\n')
  })

  it('finds the trace Claude Code and Codex write of a session', t => {
    const id = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
    const claude = scratch(t), codex = scratch(t)
    fs.mkdirSync(path.join(claude, 'projects', '-work-repo'), {recursive: true})
    fs.writeFileSync(path.join(claude, 'projects', '-work-repo', `${id}.jsonl`), '{}\n')
    fs.mkdirSync(path.join(codex, 'sessions', '2026', '10', '11'), {recursive: true})
    fs.writeFileSync(path.join(codex, 'sessions', '2026', '10', '11', `rollout-2026-10-11T10-00-00-${id}.jsonl`), '{}\n')
    const env = {CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME}
    t.after(() => { for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : process.env[k] = v })
    process.env.CLAUDE_CONFIG_DIR = claude
    process.env.CODEX_HOME = codex
    assert.deepEqual(toolOf({handle: `claude:${id}`, product: 'claude'}), {tool: 'claude', id})
    assert.deepEqual(toolOf({handle: `env:codex-${id}`, product: 'codex'}), {tool: 'codex', id})
    assert.equal(toolOf({handle: 'env:watch-local-r-codex-1', product: 'watch'}), null)
    const now = Date.now() / 1000
    for (const handle of [`claude:${id}`, `env:codex-${id}`]) assert.ok(Math.abs(traceTime({handle, product: null})! - now) < 60, handle)
    assert.equal(traceTime({handle: 'claude:00000000-0000-4000-8000-000000000000', product: 'claude'}), null)
    // A session's facts carry its trace; a stopped session waits however fresh its trace.
    const f = probe({handle: `claude:${id}`, product: 'claude', pid: process.pid, lastSeen: '2026-01-01T00:00:00Z', state: 'stopped'})
    assert.ok(f.trace && f.alive === (SUPPORTED ? true : null))
    assert.equal(judge(f).waits, 'stopped')
  })
})
