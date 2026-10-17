// The README's local journey, through the public CLI only. No store or session files are edited.
import {describe, it} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {BASE, BIN} from './cli.ts'

type Result = {code: number | null, out: string, err: string}
type Message = {id: string, from: string, subject: string, kind: string | null, state: string | null, trust: string, files: {path: string}[]}
type Task = {id: string, subject: string, state: string, by: string, taken: string[]}
type Signal = {actor: string, signal: string, target: string, ok: boolean}

describe('local flow: operator and two chat agents', () => {
  it('delivers, takes, reviews and completes work, then resumes and deletes the room', t => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ringi-flow-'))
    const home = path.join(base, 'home')
    const transcript: string[] = []
    t.after(() => {
      if (process.env.RINGI_FLOW_REPORT) fs.writeFileSync(process.env.RINGI_FLOW_REPORT, JSON.stringify({transcript}, null, 2) + '\n')
      fs.rmSync(base, {recursive: true, force: true})
    })
    const run = (args: string[], session?: string): Result => {
      const r = spawnSync(BIN[0], [...BIN.slice(1), ...args], {encoding: 'utf8', timeout: 60000,
        env: {...BASE, RINGI_HOME: home, ...(session ? {RINGI_SESSION: session} : {})}})
      const result = {code: r.status, out: r.stdout ?? '', err: r.error?.message ?? r.stderr ?? ''}
      transcript.push(`${session ?? 'operator'}: ringi ${args.join(' ')}\nexit ${result.code}\n${result.out}${result.err}`)
      return result
    }
    const ok = (args: string[], session?: string): string => {
      const r = run(args, session)
      assert.equal(r.code, 0, `${args.join(' ')}: ${r.err}`)
      return r.out
    }
    const agent = (session: string, ...args: string[]) => ok(['agent', ...args], session)
    const json = <T>(args: string[], session?: string): T => JSON.parse(ok([...args, '--json'], session))
    const sent = (out: string) => /sent (\S+)/.exec(out)?.[1] ?? assert.fail('the command returns its message id')
    const no = (args: string[], expected: RegExp, session?: string) => {
      const r = run(args, session)
      assert.notEqual(r.code, 0, `${args.join(' ')} should be refused`)
      assert.match(r.err, expected)
    }
    const codex = 'chat-codex', claude = 'chat-claude'
    const implement = 'implement tasks from operator; no commits'
    const review = 'review work from codex; no commits'
    const patch = path.join(base, 'badge.diff'), report = path.join(base, 'review.md')
    const change = '- badge: hidden\n+ badge: visible\n'
    fs.writeFileSync(patch, change)

    // The operator follows the README literally; each command starts a fresh process.
    assert.match(ok(['room', 'create', 'fix-badge']), /created room local:\/\/fix-badge/)
    for (const [session, who, scope] of [[codex, 'codex', implement], [claude, 'claude', review]]) {
      assert.match(ok(['join', 'fix-badge', '--as', who, '--scope', scope], session), /joined local:\/\/fix-badge/)
      assert.ok(agent(session, 'whoami').includes(scope))
    }
    ok(['send', '--task', '--assign', 'codex', '-m', 'Fix the badge', '-m', 'acceptance: renders on main'])
    const [work] = json<Message[]>(['agent', 'inbox'], codex)
    assert.equal(work?.subject, 'Fix the badge')
    assert.deepEqual([work.from, work.kind, work.trust], ['operator', 'task', 'asserted'])
    assert.deepEqual(json<Message[]>(['agent', 'inbox'], codex), [], 'delivery is once per chat turn')
    agent(codex, 'take', work.id)
    const working = sent(agent(codex, 'reply', work.id, '--state', 'working', '-m', 'Implementing the badge'))
    const ready = sent(agent(codex, 'reply', working, '--state', 'input-required', '-m', 'Implementation ready; awaiting review',
      '--attach', `${patch}:files/badge.diff`))
    const reviewTask = sent(agent(codex, 'send', '--task', '--assign', 'claude', '--re', ready, '-m', 'Review the badge',
      '--attach', `${patch}:files/badge.diff`))
    const before = json<Task[]>(['tasks'])
    assert.equal(before.find(x => x.id === work.id)?.state, 'input-required')
    assert.deepEqual(before.find(x => x.id === work.id)?.taken, ['codex'])
    assert.equal(before.find(x => x.id.startsWith(reviewTask))?.state, 'submitted')
    assert.match(ok(['where']), /Fix the badge[\s\S]*Review the badge|Review the badge[\s\S]*Fix the badge/)
    assert.match(ok(['read', work.id]), /Fix the badge/)

    // The reviewer is a chat of its own, on the same public CLI.
    const [toReview] = json<Message[]>(['agent', 'inbox'], claude)
    assert.equal(toReview?.subject, 'Review the badge')
    agent(claude, 'take', toReview.id)
    const checking = sent(agent(claude, 'reply', toReview.id, '--state', 'working', '-m', 'Checking the patch'))
    assert.equal(agent(claude, 'cat', toReview.id, 'files/badge.diff'), change)
    fs.writeFileSync(report, 'Reviewed the patch: badge is visible.\n')
    agent(claude, 'reply', checking, '--state', 'completed', '-m', 'Review complete', '--attach', `${report}:files/review.md`)
    const reviewMessages = json<Message[]>(['agent', 'inbox'], codex)
    const approved = reviewMessages.find(m => m.from === 'claude' && m.state === 'completed')
    assert.ok(approved, 'the reviewer replies to codex with its completed review')
    assert.equal(agent(codex, 'cat', approved.id, 'files/review.md'), fs.readFileSync(report, 'utf8'))
    const exported = path.join(base, 'received')
    agent(codex, 'get', approved.id, '-o', exported)
    assert.equal(fs.readFileSync(path.join(exported, 'files/review.md'), 'utf8'), fs.readFileSync(report, 'utf8'))
    const done = sent(agent(codex, 'reply', work.id, '--state', 'completed', '-m', 'Badge fixed and reviewed',
      '-m', `Review: ${approved.id}`, '--attach', `${patch}:files/badge.diff`, '--attach', `${report}:files/review.md`))

    // The operator sees both work items, their assignees, taken marks, states and deliverables.
    assert.deepEqual(json<Task[]>(['tasks']), [])
    const completed = json<Task[]>(['tasks', '--all'])
    assert.deepEqual(completed.map(x => [x.subject, x.state, x.by]).sort(),
      [['Fix the badge', 'completed', 'codex'], ['Review the badge', 'completed', 'claude']])
    assert.deepEqual(completed.find(x => x.id.startsWith(reviewTask))?.taken, ['claude'])
    assert.match(ok(['where']), /Badge fixed and reviewed/)
    assert.match(ok(['read', done]), /Badge fixed and reviewed/)
    const deliverable = json<Message>(['read', done])
    assert.deepEqual(deliverable.files.map(f => f.path).sort(), ['files/badge.diff', 'files/review.md'])
    assert.equal(ok(['cat', done, 'files/badge.diff']), change)
    const signals = json<Signal[]>(['signals', '--all'])
    for (const actor of ['codex', 'claude']) {
      for (const signal of ['read', 'taken', 'state.working', 'state.completed']) {
        assert.ok(signals.some(s => s.actor === actor && s.signal === signal && s.ok), `${actor}: ${signal} is visible and checked`)
      }
    }

    // Stop keeps the scope and seat; continue restores it after a process restart.
    assert.match(ok(['stop'], codex), /keeps its seat/)
    no(['agent', 'inbox'], /stopped/, codex)
    assert.match(ok(['where']), /codex +stopped/)
    assert.ok(ok(['continue'], codex).includes(implement))
    assert.ok(agent(codex, 'whoami').includes(implement))
    assert.ok(ok(['continue'], claude).includes(review))
    assert.ok(agent(claude, 'whoami').includes(review))
    for (const session of [codex, claude]) {
      assert.match(ok(['leave'], session), /seat of .* is free/)
      no(['agent', 'whoami'], /not in a room/, session)
    }
    assert.match(ok(['where']), /sessions: none joined/)
    assert.match(ok(['room', 'delete', 'fix-badge', '--yes']), /deleted room local:\/\/fix-badge/)
    assert.match(ok(['room', 'list']), /no rooms on this machine/)
  })
})
