// The acceptance cases of docs/spec/hub-1.md, through the CLI and Git/home format fixtures.
import {describe, it} from 'node:test'
import type {TestContext} from 'node:test'
import type {Session} from '../../main/ts/core/agents/sessions/index.ts'
import type {asJson} from '../../main/ts/core/hub/usecases/view.ts'
import type {Checked} from '../../main/ts/core/hub/signals/index.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {spawn, spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {BASE, BIN, FIXTURE_GIT} from './cli.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const until = async (ready: () => boolean) => {
  const end = Date.now() + 10000
  while (!ready() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20))
  assert.ok(ready(), 'the expected checkpoint was reached')
}

type RunOpt = {as?: string, env?: NodeJS.ProcessEnv}
type TaskView = {id: string, subject: string, state: string, by: string}

const world = (t: TestContext) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ringi-'))
  const home = path.join(base, 'home'), fixture = path.join(base, 'attachment.txt')
  fs.mkdirSync(home)
  fs.writeFileSync(fixture, 'attached\n')
  t.after(() => {
    spawnSync('chmod', ['-R', 'u+w', base])
    fs.rmSync(base, {recursive: true, force: true})
  })
  const run = (args: string[], {as, env}: RunOpt = {}) => {
    const r = spawnSync(BIN[0], [...BIN.slice(1), ...args], {encoding: 'utf8', env: {...BASE, RINGI_HOME: home, ...(as ? {RINGI_SESSION: as} : {}), ...env}})
    return {code: r.status, out: r.stdout, err: r.stderr}
  }
  const ok = (args: string[], opt?: RunOpt) => {
    const r = run(args, opt)
    assert.equal(r.code, 0, `ringi ${args.join(' ')}${opt?.as ? ` as ${opt.as}` : ''}: ${r.err}`)
    return r.out
  }
  const no = (args: string[], re: RegExp, opt?: RunOpt) => {
    const r = run(args, opt)
    assert.notEqual(r.code, 0, `ringi ${args.join(' ')} should fail: ${r.out}`)
    assert.match(r.err, re)
    return r.err
  }
  function json(args: ['log', ...string[]], opt?: RunOpt): ReturnType<typeof asJson>[]
  function json(args: ['tasks', ...string[]], opt?: RunOpt): TaskView[]
  function json(args: ['signals', ...string[]], opt?: RunOpt): Checked[]
  function json(args: string[], opt?: RunOpt): unknown { return JSON.parse(ok([...args, '--json'], opt)) }
  // A room's repository (hub-2: one per room).
  const repo = (room: string) => path.join(home, 'hub', 'local', 'rooms', room, 'store', '.git')
  const gitIn = (room: string, ...args: string[]) => {
    const r = spawnSync('git', ['--git-dir', repo(room), ...args], {encoding: 'utf8', env: FIXTURE_GIT})
    assert.ok(r.status === 0 || (args[0] === 'rev-parse' && args.includes('--verify') && r.status === 1),
      `git ${args.join(' ')}: ${r.stderr}`)
    return r.stdout.trim()
  }
  const git = (...args: string[]) => gitIn('r', ...args)
  // A commit by `who` on top of a room's chat, written past ringi; the tree is the tip's unless given.
  const forge = (who: string, text: string, {tree, room = 'r'}: {tree?: string, room?: string} = {}): string => {
    const ref = 'refs/heads/chat', head = gitIn(room, 'rev-parse', ref)
    const r = spawnSync('git', ['--git-dir', repo(room), 'commit-tree', tree ?? `${head}^{tree}`, '-p', head, '-m', text],
      {encoding: 'utf8', env: {...FIXTURE_GIT, GIT_AUTHOR_NAME: who, GIT_AUTHOR_EMAIL: `${who}@ringi`}})
    assert.equal(r.status, 0, r.stderr)
    gitIn(room, 'update-ref', ref, r.stdout.trim(), head)
    return r.stdout.trim()
  }
  // The room's latest control record.
  const control = (room = 'r'): string => gitIn(room, 'log', '-1', '--first-parent', '--format=%H', '--author=^operator ', '--grep=^Kind: room$', 'refs/heads/chat')
  const lastId = (args: string[], opt?: RunOpt): string => /(?:sent|proposed|approved \S+:|stamped \S+ \S+:) ([0-9a-f]{12})/.exec(ok(args, opt))?.[1] ?? assert.fail('CLI returned no message id')
  // The session records this machine keeps.
  const sessions = (): Session[] => fs.readdirSync(path.join(home, 'sessions')).map(f => JSON.parse(fs.readFileSync(path.join(home, 'sessions', f), 'utf8')))
  return {home, fixture, run, ok, no, json, git, gitIn, repo, forge, control, lastId, sessions}
}

describe('rooms', () => {
  it('exchanges tasks, replies and attachments', (t) => {
    const w = world(t)
    w.ok(['room', 'create', 'fix-badge'])
    assert.match(w.ok(['join', 'fix-badge', '--as', 'codex', '--scope', 'implement tasks from operator; no commits'], {as: 'chat-codex'}), /joined fix-badge as codex[\s\S]*scope: implement tasks from operator/)
    assert.match(w.ok(['send', '--task', '--assign', 'codex', '-m', 'Fix the badge', '-m', 'acceptance: it renders']), /sent \w+ to codex/)
    const inbox = w.ok(['agent', 'inbox'], {as: 'chat-codex'})
    assert.match(inbox, /operator \(asserted\) → codex[\s\S]*Kind: task[\s\S]*Subject: Fix the badge/)
    assert.match(inbox, /your scope: implement tasks from operator/)
    assert.match(w.ok(['agent', 'inbox'], {as: 'chat-codex'}), /nothing new/)
    const [task] = w.json(['tasks'])
    w.ok(['agent', 'reply', task.id.slice(0, 8), '--state', 'completed', '-m', 'Done', '--attach', `${w.fixture}:files/attachment.txt`], {as: 'chat-codex'})
    assert.equal(w.json(['tasks', '--all'])[0].state, 'completed')
    const where = w.ok(['where', '--short'])
    assert.match(where, /room fix-badge, genesis \w+, profile a2a-1; members: operator \(root\), codex/)
    assert.match(where, /codex +active .*env:chat-codex/)
    assert.match(where, /codex → operator +\[completed\] Done/)
    const reply = w.json(['log']).at(-1)!
    assert.equal(w.ok(['cat', reply.id, 'files/attachment.txt']), fs.readFileSync(w.fixture, 'utf8'))
    w.no(['inbox'], /agent command: ringi agent inbox/)
  })

  it('starts at once at a quorum of one and asks without one what to accept', (t) => {
    const w = world(t)
    w.ok(['room', 'create', 'plain'])
    assert.match(w.ok(['join', 'plain', '--as', 'codex'], {as: 'C'}), /scope: none recorded; ask the operator what to accept/)
    w.ok(['room', 'create', 'r', '--quorum', '1'])
    w.ok(['send', '--task', '--assign', 'codex', '-m', 'Job'])
    const joined = w.ok(['join', 'r', '--as', 'codex'], {as: 'C'})
    assert.match(joined, /scope: none recorded; the room's work for you/)
    assert.match(joined, /^started: room r has its quorum \(1 of 1 agents\); your first turn starts now[\s\S]*Subject: Job/m)
    assert.match(w.ok(['agent', 'whoami'], {as: 'C'}), /scope: none recorded; the room's work for you/)
    w.ok(['stop'], {as: 'C'})
    assert.match(w.ok(['continue'], {as: 'C'}), /^started: room r has its quorum/m)
  })

  it('waits for its quorum of agents and starts by itself', (t) => {
    const w = world(t)
    w.no(['room', 'create', 'r', '--quorum', '0'], /--quorum takes a number of agents/)
    assert.match(w.ok(['room', 'create', 'r', '--quorum', '2']), /starts by itself at a quorum of 2 agent/)
    w.ok(['send', '--task', '--assign', 'codex', '-m', 'Job'])
    const first = w.ok(['join', 'r', '--as', 'codex'], {as: 'C'})
    assert.match(first, /^waiting: room r waits for a quorum of 2 agents and has 1; nothing to do yet/m)
    assert.doesNotMatch(first, /Job|inbox:/)
    assert.match(w.ok(['agent', 'inbox'], {as: 'C'}), /^waiting: room r waits for a quorum of 2 agents and has 1/m)
    assert.match(w.ok(['where']), /waiting for a quorum of 2 agents, has 1/)
    // Nothing was read while it waited.
    assert.equal(w.json(['signals']).filter(s => s.signal === 'read').length, 0)
    const second = w.ok(['join', 'r', '--as', 'claude'], {as: 'L'})
    assert.match(second, /^started: room r has its quorum \(2 of 2 agents\); your first turn starts now/m)
    assert.match(second, /scope: none recorded; the room's work for you/)
    assert.match(w.ok(['agent', 'inbox'], {as: 'C'}), /Subject: Job/)
    assert.match(w.ok(['where']), /started at its quorum of 2 agents/)
  })

  it('shows each session\'s pulse without touching it', (t) => {
    const w = world(t)
    w.ok(['room', 'create', 'r', '--quorum', '2'])
    w.ok(['join', 'r', '--as', 'codex'], {as: 'C'})
    const before = w.sessions()[0].lastSeen
    const [p] = JSON.parse(w.ok(['heartbeats', '--json']))
    assert.deepEqual([p.session.agent, p.beat.state, p.beat.waits, p.beat.alive], ['codex', 'waiting', 'quorum', null])
    assert.equal(w.sessions()[0].lastSeen, before, 'a look renews no lease')
    w.ok(['join', 'r', '--as', 'claude'], {as: 'L'})
    assert.match(w.ok(['heartbeats']), /^codex +r +working +alive \? +quiet \d+s +none +env:C$/m)
  })

  it('appends a telemetry record on every beat, naming the last pulled message', (t) => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    w.ok(['join', 'r', '--as', 'codex'], {as: 'C'})
    w.ok(['send', '--to', 'codex', '-m', 'work'])
    w.ok(['pulse', '--once'])
    const ref = 'refs/heads/codex/telemetry', first = w.git('rev-parse', ref)
    const record = (rev: string) => w.git('log', '-1', '--format=%an%n%B', rev)
    assert.match(record(ref), /^codex\n/)
    for (const fact of [/^State: working$/m, /^Alive: unknown$/m, /^Quiet: \d+$/m, /^Next: 30$/m, new RegExp(`^Target: ${w.git('rev-parse', 'refs/heads/chat')}$`, 'm')]) assert.match(record(ref), fact)
    assert.deepEqual(JSON.parse(w.ok(['heartbeats', '--published', '--json'])).map((h: {agent: string, state: string, overdue: boolean}) => [h.agent, h.state, h.overdue]), [['codex', 'working', false]])
    // Telemetry is no signal: readers list none of it and raise no alarm.
    assert.ok(!w.json(['signals', '--all']).some(x => x.ref === first))
    w.ok(['send', '--to', 'codex', '-m', 'more'])
    w.ok(['pulse', '--once'])
    assert.equal(w.git('rev-parse', `${ref}^`), first)
    assert.match(record(ref), new RegExp(`^Target: ${w.git('rev-parse', 'refs/heads/chat')}$`, 'm'))
    assert.equal(w.run(['signals', '--all']).err, '')
    w.ok(['room', 'delete', 'r', '--yes'])
    assert.equal(fs.existsSync(w.repo('r')), false)
  })

  it('keeps agents bound when the operator switches rooms', (t) => {
    const w = world(t)
    w.ok(['room', 'create', 'one'])
    w.ok(['join', 'one', '--as', 'codex'], {as: 'C'})
    w.ok(['send', '--to', 'codex', '-m', 'for one'])
    w.ok(['room', 'create', 'two'])
    w.ok(['send', '--to', 'codex', '-m', 'for two'])
    const inbox = w.ok(['agent', 'inbox'], {as: 'C'})
    assert.match(inbox, /for one/)
    assert.doesNotMatch(inbox, /for two/)
    assert.match(w.ok(['where']), /room two[\s\S]*sessions: none joined/)
    assert.match(w.ok(['room', 'list']), /\* two/)
  })

  it('requires --yes to delete, and takes the room of the current context', (t) => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    w.no(['room', 'delete'], /deleting r erases its store on this machine .*--yes/)
    assert.match(w.ok(['room', 'delete', '--yes']), /deleted room r/)
    assert.equal(fs.existsSync(w.repo('r')), false)
    w.no(['room', 'delete', '--yes'], /no current room/)
  })

  it('erases a room and everything kept for it, and its sessions leave on their own', (t) => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    w.ok(['join', 'r', '--as', 'codex'], {as: 'C'})
    const task = w.lastId(['send', '--task', '--assign', 'codex', '-m', 'Job', '--attach', `${w.fixture}:spec.txt`])
    w.ok(['agent', 'inbox'], {as: 'C'})
    w.ok(['agent', 'reply', task, '--state', 'completed', '-m', 'done'], {as: 'C'})
    const genesis = w.git('rev-list', '--reverse', 'refs/heads/chat', '^refs/heads/main').split('\n')[0]
    const hub = JSON.parse(fs.readFileSync(path.join(w.home, 'hub', 'local', 'hub.json'), 'utf8')).genesis
    assert.ok(fs.existsSync(path.join(w.home, 'readers', hub, genesis)))
    // Another room stays as it is, to the last ref.
    w.ok(['room', 'create', 'other'])
    w.ok(['join', 'other', '--as', 'claude'], {as: 'L'})
    w.ok(['send', '--to', 'claude', '-m', 'stays'])
    w.ok(['agent', 'inbox'], {as: 'L'})
    const kept = w.gitIn('other', 'for-each-ref')
    assert.match(kept, /refs\/heads\/claude\/signals/)
    assert.match(w.ok(['room', 'delete', 'r', '--yes']), /deleted room r/)
    assert.equal(fs.existsSync(path.join(w.home, 'hub', 'local', 'rooms', 'r')), false)
    assert.equal(fs.existsSync(path.join(w.home, 'readers', hub, genesis)), false)
    assert.equal(w.gitIn('other', 'for-each-ref'), kept)
    assert.match(w.ok(['log', '--room', 'other']), /stays/)
    // The session finds the room gone and leaves on its own; the other room's session is untouched.
    w.no(['agent', 'inbox'], /room r is gone from hub local; this session left it/, {as: 'C'})
    w.no(['agent', 'inbox'], /this session is not in a room/, {as: 'C'})
    assert.match(w.ok(['agent', 'whoami'], {as: 'L'}), /claude in other/)
  })

  it('ends old bindings when a room is recreated', (t) => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    w.ok(['join', 'r', '--as', 'codex'], {as: 'C'})
    w.ok(['room', 'delete', 'r', '--yes'])
    w.ok(['room', 'create', 'r'])
    w.no(['agent', 'inbox'], /deleted and created again/, {as: 'C'})
  })
})

describe('sessions', () => {
  it('resumes the same seat and requires explicit takeover', (t) => {
    const w = world(t)
    w.ok(['room', 'create', 'fix'])
    w.ok(['join', 'fix', '--as', 'claude', '--scope', 'review'], {as: 'A'})
    w.no(['join', 'fix', '--as', 'claude'], /held by another session \(env:A, active\)/, {as: 'B'})
    w.no(['continue'], /nothing to continue/, {as: 'B'})
    w.no(['continue', 'fix/claude'], /held by a live session/, {as: 'B'})
    // A restart of the same chat: the lease lapsed, the handle is the same.
    const f = fs.readdirSync(path.join(w.home, 'sessions')).find(x => JSON.parse(fs.readFileSync(path.join(w.home, 'sessions', x), 'utf8')).handle === 'env:A')!
    const rec = JSON.parse(fs.readFileSync(path.join(w.home, 'sessions', f), 'utf8'))
    fs.writeFileSync(path.join(w.home, 'sessions', f), JSON.stringify({...rec, lastSeen: '2020-01-01T00:00:00Z'}))
    assert.match(w.ok(['where']), /claude +gone/)
    assert.match(w.ok(['continue'], {as: 'A'}), /claude in fix; scope: review/)
    assert.match(w.ok(['where']), /claude +active/)
    // A pause keeps the seat and blocks every agent command.
    assert.match(w.ok(['stop'], {as: 'A'}), /keeps its seat/)
    w.no(['agent', 'inbox'], /stopped/, {as: 'A'})
    w.no(['join', 'fix', '--as', 'claude'], /held by another session \(env:A, stopped\)/, {as: 'B'})
    // The operator's explicit takeover from another chat, with the recorded scope.
    assert.match(w.no(['continue'], /continue fix\/claude/, {as: 'B'}), /stopped/)
    assert.match(w.ok(['continue', 'fix/claude'], {as: 'B'}), /claude in fix; scope: review/)
    w.no(['agent', 'inbox'], /not in a room/, {as: 'A'})
    assert.match(w.ok(['leave'], {as: 'B'}), /seat of claude is free/)
    assert.match(w.ok(['join', 'fix', '--as', 'claude'], {as: 'A'}), /scope: none recorded/)
  })

  it('identifies each chat by its session', (t) => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    assert.match(w.ok(['join', 'r'], {env: {CLAUDE_CODE_SESSION_ID: 'abc', CLAUDECODE: '1'}}), /joined r as claude/)
    assert.ok(w.sessions().some(s => s.handle === 'claude:abc'))
    // Without a chat id ringi falls back to the UI process among its ancestors (here, possibly the developer's own
    // Claude Code), and without that it asks for RINGI_SESSION; either way it never guesses a binding.
    w.no(['agent', 'whoami'], /cannot tell which session this is: set RINGI_SESSION|this session is not in a room/)
  })
})

describe('agent inbox and waiting', () => {
  it('pages delivery, leaves peeks unread and validates limits', t => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    w.ok(['join', 'r', '--as', 'codex'], {as: 'C'})
    for (const subject of ['one', 'two', 'three']) w.ok(['send', '--to', 'codex', '-m', subject])
    const inbox = (...args: string[]): ReturnType<typeof asJson>[] => JSON.parse(w.ok(['agent', 'inbox', '--json', ...args], {as: 'C'}))
    assert.deepEqual(inbox('--peek', '--limit', '2').map(m => m.subject), ['one', 'two'])
    assert.equal(w.json(['signals']).filter(s => s.signal === 'read').length, 0)
    assert.deepEqual(inbox('--limit', '2').map(m => m.subject), ['one', 'two'])
    assert.deepEqual(inbox().map(m => m.subject), ['three'])
    assert.deepEqual(inbox(), [])
    for (const limit of ['0', '-1', 'NaN']) w.no(['agent', 'inbox', '--limit', limit], /positive integer/, {as: 'C'})
    w.no(['agent', 'wait', '--max', 'NaN'], /nonnegative seconds/, {as: 'C'})
    assert.equal(w.run(['agent', 'wait', '--max', '0'], {as: 'C'}).code, 3)
  })

  it('ends a wait when the operator stops the chat', async t => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    w.ok(['join', 'r', '--as', 'codex'], {as: 'C'})
    const before = w.sessions()[0].lastSeen
    const child = spawn(BIN[0], [...BIN.slice(1), 'agent', 'wait', '--max', '30'], {env: {...BASE, RINGI_HOME: w.home, RINGI_SESSION: 'C'}})
    let error = ''
    child.stderr.on('data', b => { error += b })
    const exit = new Promise(resolve => child.once('exit', resolve))
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL') })
    await until(() => w.sessions()[0].lastSeen !== before)
    w.ok(['stop'], {as: 'C'})
    assert.equal(await exit, 1)
    assert.match(error, /stopped/)
  })
})

describe('journals and attachments', () => {
  it('refuses malformed attachment metadata while other logs remain readable', t => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    w.ok(['join', 'r', '--as', 'codex'], {as: 'C'})
    w.ok(['agent', 'send', '--to', 'operator', '-m', 'valid other log'], {as: 'C'})
    for (const value of ['not json', '[1]', '["../x"]', '["x", "x"]', '["A", "a"]', '[]\nRingi-Files: []', '["\\u001b"]']) {
      const id = w.forge('operator', `bad attachment\n\nTo: codex\nRingi-Files: ${value}`)
      const records = w.json(['log'])
      const bad = records.find(m => m.id === id)!
      assert.deepEqual(bad.files, [])
      assert.match(bad.refused[0].why!, /safe, distinct file paths/)
      assert.ok(records.some(m => m.subject === 'valid other log'))
      assert.doesNotMatch(w.ok(['read', id]), /\u001b/)
    }
    assert.match(w.ok(['agent', 'inbox'], {as: 'C'}), /Refused: Ringi-Files/)
  })

  it('reads many declared paths and explains an oversized attachment list', t => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    const first = w.lastId(['send', '-m', 'first', '--attach', `${w.fixture}:present`])
    const names = ['present', ...Array.from({length: 8000}, (_, i) => `p${i.toString(36)}`)]
    const id = w.forge('operator', `many paths\n\nTo: *\nRingi-Files: ${JSON.stringify(names)}`)
    const record = w.json(['log']).find(m => m.id === id)!
    assert.deepEqual(record.files.map(f => f.path), ['present'])
    assert.equal(record.refused.length, 8000)
    assert.equal(w.ok(['cat', first, 'present']), w.ok(['cat', id, 'present']))
    const long = Array(270).fill('x'.repeat(250)).join('/')
    w.no(['send', '-m', 'oversized', '--attach', `${w.fixture}:${long}`], /attachment list.*64 KiB/)
    assert.equal(w.git('rev-parse', 'refs/heads/chat'), id)
  })

  it('reattaches identical files without carrying files omitted by a later message', t => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    const name = 'files/a "quoted" ü.txt'
    const first = w.lastId(['send', '-m', 'first', '--attach', `${w.fixture}:${name}`])
    const again = w.lastId(['send', '-m', 'again', '--attach', `${w.fixture}:${name}`])
    const plain = w.lastId(['send', '-m', 'plain'])
    for (const id of [first, again]) assert.equal(w.ok(['cat', id, name]), fs.readFileSync(w.fixture, 'utf8'))
    assert.ok(w.ok(['read', again]).includes(`${name} (9 B)`))
    assert.deepEqual(w.json(['log']).find(m => m.id.startsWith(plain))!.files, [])
    assert.doesNotMatch(w.ok(['read', again]), /Ringi-Files:/i)
    // Older commits retain changed-path semantics, including a carried tree on a text-only record.
    const old = w.forge('operator', 'old plain\n\nTo: *')
    assert.deepEqual(w.json(['log']).find(m => m.id === old)!.files, [])
  })

  it('takes an attachment\'s content when the message is sent, and refuses one over the limit', t => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    w.ok(['join', 'r', '--as', 'codex'], {as: 'C'})
    const dir = fs.mkdtempSync(path.join(w.home, 'work-'))
    const file = (name: string, text: string) => { const f = path.join(dir, name); fs.writeFileSync(f, text); return f }
    const a = file('a.txt', 'first\n')
    const sent = w.lastId(['send', '--to', 'codex', '-m', 'with a file', '--attach', `${a}:out/a.txt`])
    fs.writeFileSync(a, 'changed after send\n')
    assert.equal(w.ok(['cat', sent, 'out/a.txt']), 'first\n')
    // An agent's reply carries its own.
    const reply = w.lastId(['agent', 'reply', sent, '-m', 'done', '--attach', `${file('r.md', 'report')}:report.md`], {as: 'C'})
    assert.equal(w.ok(['cat', reply, 'report.md']), 'report')
    const big = path.join(dir, 'big.bin')
    fs.writeFileSync(big, '')
    fs.truncateSync(big, 65 << 20)
    w.no(['send', '--to', 'codex', '-m', 'big', '--attach', big], /at most 64 MiB/)
  })

  it('quarantines rewritten, deleted and foreign histories', (t) => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    w.ok(['join', 'r', '--as', 'codex'], {as: 'C'})
    const joined = w.git('rev-parse', 'refs/heads/chat')
    w.ok(['agent', 'send', '--to', 'operator', '-m', 'one'], {as: 'C'})
    w.ok(['agent', 'send', '--to', 'operator', '-m', 'two'], {as: 'C'})
    assert.equal(w.json(['log']).length, 2)
    const ref = 'refs/heads/chat'
    const head = w.git('rev-parse', ref)
    // The room's branch rolled back past codex's last message.
    w.git('update-ref', ref, `${head}^`)
    const rolled = w.run(['log'])
    assert.match(rolled.err, /ALARM log codex was rewritten/)
    assert.equal(rolled.out, '')
    w.git('update-ref', ref, head)
    assert.equal(w.json(['log']).length, 2)
    // Rolled back past all of them.
    w.git('update-ref', ref, joined)
    assert.match(w.run(['log']).err, /ALARM log codex was deleted/)
    // A chat that does not grow from the room's genesis is not the room.
    const stray = w.git('commit-tree', w.git('hash-object', '-w', '-t', 'tree', '--stdin'), '-m', 'stray\n\nTo: *')
    w.git('update-ref', ref, stray)
    assert.match(w.run(['log']).err, /ALARM room r: changed genesis/)
    w.git('update-ref', ref, `${head}^`)
    assert.match(w.ok(['forget', 'r/codex']), /forgot the accepted history of r\/codex/)
    assert.deepEqual(w.json(['log']).map(m => m.subject), ['one'])
    assert.match(w.git('for-each-ref', 'refs/ringi/accepted/'), /\/operator\/logs\/codex/)
  })

  it('shows attachment sizes', (t) => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    w.ok(['join', 'r', '--as', 'codex'], {as: 'C'})
    w.ok(['send', '--to', 'codex', '-m', 'file', '--attach', `${w.fixture}:files/attachment.txt`])
    assert.match(w.ok(['agent', 'inbox'], {as: 'C'}), /Files: files\/attachment\.txt \(9 B\)/)
  })
})

describe('contracts', () => {
  it('accepts minor versions and refuses unknown contracts', (t) => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    assert.match(w.ok(['hub']), /^local +git, asserted, contract 2\.0/m)
    w.ok(['hub', 'amend', '-m', 'note', '--set', 'version=2.1'])
    // A room keeps the contract it was made with; a room made after follows the new one.
    assert.match(w.ok(['where']), /contract 2\.0/)
    w.ok(['room', 'create', 'r2'])
    assert.match(w.ok(['where']), /contract 2\.1/)
    assert.match(w.ok(['where', '--room', 'r']), /contract 2\.0/)
    // This ringi writes no contract it would refuse to read.
    w.no(['hub', 'amend', '-m', 'teleport', '--set', 'capabilities=profiles/1,teleport/1'], /requires teleport\/1, which this ringi .* cannot enforce/)
    w.no(['hub', 'amend', '-m', 'v3', '--set', 'version=3.0'], /follows contract version 3\.0; this ringi .* supports 2\.x/)
    assert.match(w.ok(['hub']), /contract 2\.1/)
    const w3 = world(t)
    fs.writeFileSync(path.join(w3.home, 'stray'), 'x')
    w3.no(['room', 'create', 'r'], /not a ringi home \(no home\.json\)/)
    const w4 = world(t)
    fs.writeFileSync(path.join(w4.home, 'home.json'), JSON.stringify({version: 3}))
    w4.no(['room', 'list'], /ringi home of version 3; this ringi .* needs version 4\. Move it away/)
  })

})

describe('state and locks', () => {
  for (const [owner, token] of [['live', `${process.pid}.test`], ['unknown', '']]) {
    it(`preserves ${owner} owners regardless of lock age`, (t) => {
      const w = world(t)
      w.ok(['room', 'create', 'r'])
      w.ok(['join', 'r', '--as', 'codex'], {as: 'C'})
      const lock = path.join(w.home, 'locks', 'sessions.lock')
      fs.writeFileSync(lock, token)
      fs.utimesSync(lock, new Date(0), new Date(0))
      const r = spawnSync(BIN[0], [...BIN.slice(1), 'agent', 'whoami'], {encoding: 'utf8', timeout: 2000, env: {...BASE, RINGI_HOME: w.home, RINGI_SESSION: 'C'}})
      assert.equal(r.signal, 'SIGTERM', `waited for ${owner} owner: ${r.stderr}`)
      assert.equal(fs.readFileSync(lock, 'utf8'), token)
    })
  }

  it('recovers dead lock owners', (t) => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    w.ok(['join', 'r', '--as', 'codex'], {as: 'C'})
    const lock = path.join(w.home, 'locks', 'sessions.lock')
    fs.writeFileSync(lock, '999999.dead')
    assert.match(w.ok(['agent', 'whoami'], {as: 'C'}), /codex in r/)
  })

  it('explains sandbox write failures', (t) => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    w.ok(['join', 'r', '--as', 'codex'], {as: 'C'})
    fs.chmodSync(path.join(w.home, 'locks'), 0o500)
    const err = w.no(['agent', 'inbox'], /cannot write/, {as: 'C'})
    assert.match(err, /re-run this same command with your host's sandbox escalation/)
    assert.match(err, /writable_roots/)
    fs.chmodSync(path.join(w.home, 'locks'), 0o700)
  })
})

describe('CLI reference', () => {
  it('generates COMMANDS.md from the command table', () => {
    const md = spawnSync(BIN[0], [...BIN.slice(1), 'help', '--md'], {encoding: 'utf8', env: BASE}).stdout
    assert.equal(fs.readFileSync(path.join(HERE, '../../../COMMANDS.md'), 'utf8'), md, 'run: npm run commands')
    for (const c of ['join <room>', 'continue', 'stop', 'leave', 'where', 'agent inbox', 'room delete', 'heartbeats']) assert.ok(md.includes(`ringi ${c}`), c)
  })
})
