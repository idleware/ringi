// ringi 0.2: the acceptance cases of docs/spec/hub-1.md, end to end through the command line.
import {describe, it} from 'node:test'
import type {TestContext} from 'node:test'
import type {Session} from '../../main/ts/runtime/session.ts'
import type {asJson} from '../../main/ts/app/view.ts'
import type {Proposal} from '../../main/ts/domain/decisions.ts'
import type {Checked} from '../../main/ts/domain/signals.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {spawn, spawnSync} from 'node:child_process'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {bytes, locked} from '../../main/ts/lib/index.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(HERE, '../../../target/esm/cli.js')
const NODE = process.execPath
// The tests must not see the developer's own chat: no host session variables leak in.
const BASE = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|CODEX|CURSOR|RINGI_|GIT_)/.test(k)))
const until = async (ready: () => boolean) => {
  const end = Date.now() + 10000
  while (!ready() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20))
  assert.ok(ready(), 'the expected checkpoint was reached')
}

type RunOpt = {as?: string, env?: NodeJS.ProcessEnv}
type TaskView = {id: string, subject: string, state: string, by: string}
type ProposalView = Pick<Proposal, 'state' | 'stamps'> & {id: string, subject: string}

const world = (t: TestContext) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ringi-'))
  t.after(() => {
    spawnSync('chmod', ['-R', 'u+w', home])
    fs.rmSync(home, {recursive: true, force: true})
  })
  const run = (args: string[], {as, env}: RunOpt = {}) => {
    const r = spawnSync(NODE, [CLI, ...args], {encoding: 'utf8', env: {...BASE, RINGI_HOME: home, ...(as ? {RINGI_SESSION: as} : {}), ...env}})
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
  function json(args: ['sessions', ...string[]], opt?: RunOpt): Session[]
  function json(args: ['proposals', ...string[]], opt?: RunOpt): ProposalView[]
  function json(args: ['signals', ...string[]], opt?: RunOpt): Checked[]
  function json(args: string[], opt?: RunOpt): unknown { return JSON.parse(ok([...args, '--json'], opt)) }
  const git = (...args: string[]) => spawnSync('git', ['--git-dir', path.join(home, 'hub', 'local', 'store', '.git'), ...args], {encoding: 'utf8'}).stdout.trim()
  const lastId = (args: string[], opt?: RunOpt): string => /(?:sent|proposed|approved \S+:|stamped \S+ \S+:) ([0-9a-f]{12})/.exec(ok(args, opt))?.[1] ?? assert.fail('CLI returned no message id')
  return {home, run, ok, no, json, git, lastId}
}

describe('rooms', () => {
  it('exchanges tasks, replies and attachments', (t) => {
    const w = world(t)
    w.ok(['room', 'create', 'fix-badge'])
    assert.match(w.ok(['join', 'local', 'fix-badge', '--as', 'codex', '--scope', 'implement tasks from operator; no commits'], {as: 'chat-codex'}), /joined local\/fix-badge as codex[\s\S]*scope: implement tasks from operator/)
    assert.match(w.ok(['send', '--task', '--assign', 'codex', '-m', 'Fix the badge', '-m', 'acceptance: it renders']), /sent \w+ to codex/)
    const inbox = w.ok(['agent', 'inbox'], {as: 'chat-codex'})
    assert.match(inbox, /operator \(asserted\) → codex[\s\S]*Kind: task[\s\S]*Subject: Fix the badge/)
    assert.match(inbox, /your scope: implement tasks from operator/)
    assert.match(w.ok(['agent', 'inbox'], {as: 'chat-codex'}), /nothing new/)
    const [task] = w.json(['tasks'])
    w.ok(['agent', 'reply', task.id.slice(0, 8), '--state', 'completed', '-m', 'Done', '--attach', `${CLI}:files/cli.js`], {as: 'chat-codex'})
    assert.equal(w.json(['tasks', '--all'])[0].state, 'completed')
    const where = w.ok(['where', '--short'])
    assert.match(where, /room fix-badge, genesis \w+, profile a2a-1; members: operator \(root\), codex/)
    assert.match(where, /codex +active .*env:chat-codex/)
    assert.match(where, /codex → operator +\[completed\] Done/)
    const reply = w.json(['log']).at(-1)!
    assert.equal(w.ok(['cat', reply.id, 'files/cli.js']), fs.readFileSync(CLI, 'utf8'))
    w.no(['inbox'], /agent command: ringi agent inbox/)
  })

  it('keeps agents bound when the operator switches rooms', (t) => {
    const w = world(t)
    w.ok(['room', 'create', 'one'])
    w.ok(['join', 'local', 'one', '--as', 'codex'], {as: 'C'})
    w.ok(['send', '--to', 'codex', '-m', 'for one'])
    w.ok(['room', 'create', 'two'])
    w.ok(['send', '--to', 'codex', '-m', 'for two'])
    const inbox = w.ok(['agent', 'inbox'], {as: 'C'})
    assert.match(inbox, /for one/)
    assert.doesNotMatch(inbox, /for two/)
    assert.match(w.ok(['where']), /room two[\s\S]*sessions: none joined/)
    assert.match(w.ok(['room', 'list']), /\* two/)
  })

  it('archives read-only rooms and requires --yes to delete', (t) => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    w.ok(['join', 'local', 'r', '--as', 'codex'], {as: 'C'})
    w.ok(['send', '--to', 'codex', '-m', 'before'])
    const done = w.ok(['room', 'archive', 'r'])
    const name = /archived r as (r@\w+)/.exec(done)![1]
    w.no(['agent', 'inbox'], /archived as r@/, {as: 'C'})
    assert.match(w.ok(['log', '--room', name]), /before/)
    w.no(['send', '--room', name, '-m', 'after'], /archived: read-only/)
    assert.match(w.ok(['room', 'list', '--archived']), new RegExp(`${name} +archived`))
    w.ok(['room', 'create', 'r'])
    w.ok(['send', '--to', 'codex', '-m', 'new room'])
    w.no(['agent', 'inbox'], /archived/, {as: 'C'})
    w.no(['room', 'delete', 'r'], /--yes/)
    assert.match(w.ok(['room', 'delete', 'r', '--yes']), /deleted room r/)
    assert.equal(w.git('for-each-ref', 'refs/heads/r/'), '')
  })

  it('ends old bindings when a room is recreated', (t) => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    w.ok(['join', 'local', 'r', '--as', 'codex'], {as: 'C'})
    w.ok(['room', 'delete', 'r', '--yes'])
    w.ok(['room', 'create', 'r'])
    w.no(['agent', 'inbox'], /deleted and created again/, {as: 'C'})
  })
})

describe('sessions', () => {
  it('hands off only its own active seat and returns it after the watcher ends', async t => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    w.ok(['join', 'local', 'r', '--as', 'claude', '--scope', 'review only'], {as: 'A'})
    const watch = ['watch', 'r/claude', '--once', '--handoff', '--exec', 'true']
    w.no(watch, /invoking chat to own this seat/, {as: 'B'})
    w.ok(['stop'], {as: 'A'})
    w.no(watch, /stopped.*continue/, {as: 'A'})
    w.ok(['continue'], {as: 'A'})
    w.ok(['send', '--task', '--assign', 'claude', '-m', 'Review'])
    const marker = path.join(w.home, 'running')
    const child = spawn(NODE, [CLI, ...watch.slice(0, -1), `touch '${marker}'; sleep 2`], {env: {...BASE, RINGI_HOME: w.home, RINGI_SESSION: 'A'}, stdio: 'ignore'})
    const exit = new Promise(resolve => child.once('exit', resolve))
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL') })
    await until(() => fs.existsSync(marker))
    w.no(['continue'], /held by a live session/, {as: 'A'})
    w.no(['agent', 'inbox'], /not in a room/, {as: 'A'})
    w.ok(['room', 'create', 'other'])
    w.no(['join', 'local', 'other', '--as', 'claude'], /handed its seat to a live watcher/, {as: 'A'})
    w.ok(['stop'], {as: 'A'})
    w.no(['continue', 'r/claude'], /held by a live session/, {as: 'B'})
    assert.equal(await exit, 0)
    assert.match(w.ok(['continue'], {as: 'A'}), /claude in local\/r; scope: review only/)
    assert.match(w.ok(['agent', 'whoami'], {as: 'A'}), /session env:A, active/)
  })

  it('resumes the same seat and requires explicit takeover', (t) => {
    const w = world(t)
    w.ok(['room', 'create', 'fix'])
    w.ok(['join', 'local', 'fix', '--as', 'claude', '--scope', 'review'], {as: 'A'})
    w.no(['join', 'local', 'fix', '--as', 'claude'], /held by another session \(env:A, active\)/, {as: 'B'})
    w.no(['continue'], /nothing to continue/, {as: 'B'})
    w.no(['continue', 'fix/claude'], /held by a live session/, {as: 'B'})
    // A restart of the same chat: the lease lapsed, the handle is the same.
    const f = fs.readdirSync(path.join(w.home, 'sessions')).find(x => x.startsWith('env_A-'))!
    const rec = JSON.parse(fs.readFileSync(path.join(w.home, 'sessions', f), 'utf8'))
    fs.writeFileSync(path.join(w.home, 'sessions', f), JSON.stringify({...rec, lastSeen: '2020-01-01T00:00:00Z'}))
    assert.match(w.ok(['where']), /claude +gone/)
    assert.match(w.ok(['continue'], {as: 'A'}), /claude in local\/fix; scope: review/)
    assert.match(w.ok(['where']), /claude +active/)
    // A pause keeps the seat and blocks every agent command.
    assert.match(w.ok(['stop'], {as: 'A'}), /keeps its seat/)
    w.no(['agent', 'inbox'], /stopped/, {as: 'A'})
    w.no(['join', 'local', 'fix', '--as', 'claude'], /held by another session \(env:A, stopped\)/, {as: 'B'})
    // The operator's explicit takeover from another chat, with the recorded scope.
    assert.match(w.no(['continue'], /continue local:fix\/claude/, {as: 'B'}), /stopped/)
    assert.match(w.ok(['continue', 'fix/claude'], {as: 'B'}), /claude in local\/fix; scope: review/)
    w.no(['agent', 'inbox'], /not in a room/, {as: 'A'})
    assert.match(w.ok(['leave'], {as: 'B'}), /seat of claude is free/)
    assert.match(w.ok(['join', 'local', 'fix', '--as', 'claude'], {as: 'A'}), /scope: none recorded/)
  })

  it('identifies each chat by its session', (t) => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    assert.match(w.ok(['join', 'local', 'r'], {env: {CLAUDE_CODE_SESSION_ID: 'abc', CLAUDECODE: '1'}}), /joined local\/r as claude/)
    assert.match(w.ok(['sessions']), /claude:abc/)
    // Without a chat id ringi falls back to the UI process among its ancestors (here, possibly the developer's own
    // Claude Code), and without that it asks for RINGI_SESSION; either way it never guesses a binding.
    w.no(['agent', 'whoami'], /cannot tell which session this is: set RINGI_SESSION|this session is not in a room/)
  })
})

describe('agent inbox and waiting', () => {
  it('answers an unacknowledged ping once, without relying on timestamp precision', t => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    w.ok(['join', 'local', 'r', '--as', 'codex'], {as: 'C'})
    w.ok(['join', 'local', 'r', '--as', 'claude'], {as: 'L'})
    w.ok(['agent', 'ping', 'codex'], {as: 'L'})
    for (let i = 0; i < 2; i++) {
      assert.equal(w.run(['agent', 'wait', '--max', '0'], {as: 'C'}).code, 3)
      assert.equal(w.json(['log', '--all']).filter(m => m.kind === 'pong').length, 1)
    }
  })

  it('pages delivery, leaves peeks unread and validates limits', t => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    w.ok(['join', 'local', 'r', '--as', 'codex'], {as: 'C'})
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
    w.ok(['join', 'local', 'r', '--as', 'codex'], {as: 'C'})
    const before = w.json(['sessions'])[0].lastSeen
    const child = spawn(NODE, [CLI, 'agent', 'wait', '--max', '5'], {env: {...BASE, RINGI_HOME: w.home, RINGI_SESSION: 'C'}})
    let error = ''
    child.stderr.on('data', b => { error += b })
    const exit = new Promise(resolve => child.once('exit', resolve))
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL') })
    await until(() => w.json(['sessions'])[0].lastSeen !== before)
    w.ok(['stop'], {as: 'C'})
    assert.equal(await exit, 1)
    assert.match(error, /stopped/)
  })
})

describe('journals and attachments', () => {
  it('refuses malformed attachment metadata while other logs remain readable', t => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    w.ok(['join', 'local', 'r', '--as', 'codex'], {as: 'C'})
    w.ok(['agent', 'send', '--to', 'operator', '-m', 'valid other log'], {as: 'C'})
    const ref = 'refs/heads/r/log/operator', genesis = w.git('rev-parse', 'refs/heads/r/control')
    const tree = w.git('rev-parse', `${genesis}^{tree}`)
    for (const value of ['not json', '[1]', '["../x"]', '["x", "x"]', '["A", "a"]', '[]\nRingi-Files: []', '["\\u001b"]']) {
      const head = w.git('rev-parse', '-q', '--verify', ref) || genesis
      const id = w.git('commit-tree', tree, '-p', head, '-m', `bad attachment\n\nTo: codex\nRingi-Files: ${value}`)
      w.git('update-ref', ref, id)
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
    const first = w.lastId(['send', '-m', 'first', '--attach', `${CLI}:present`])
    const head = w.git('rev-parse', 'refs/heads/r/log/operator')
    const names = ['present', ...Array.from({length: 8000}, (_, i) => `p${i.toString(36)}`)]
    const text = `many paths\n\nTo: *\nRingi-Files: ${JSON.stringify(names)}`
    const id = w.git('commit-tree', w.git('rev-parse', `${head}^{tree}`), '-p', head, '-m', text)
    w.git('update-ref', 'refs/heads/r/log/operator', id, head)
    const record = w.json(['log']).find(m => m.id === id)!
    assert.deepEqual(record.files.map(f => f.path), ['present'])
    assert.equal(record.refused.length, 8000)
    assert.equal(w.ok(['cat', first, 'present']), w.ok(['cat', id, 'present']))
    const long = Array(270).fill('x'.repeat(250)).join('/')
    w.no(['send', '-m', 'oversized', '--attach', `${CLI}:${long}`], /attachment list.*64 KiB/)
    assert.equal(w.git('rev-parse', 'refs/heads/r/log/operator'), id)
  })

  it('reattaches identical files without carrying files omitted by a later message', t => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    const name = 'files/a "quoted" ü.txt'
    const first = w.lastId(['send', '-m', 'first', '--attach', `${CLI}:${name}`])
    const again = w.lastId(['send', '-m', 'again', '--attach', `${CLI}:${name}`])
    const plain = w.lastId(['send', '-m', 'plain'])
    for (const id of [first, again]) assert.equal(w.ok(['cat', id, name]), fs.readFileSync(CLI, 'utf8'))
    assert.ok(w.ok(['read', again]).includes(`${name} (${bytes(fs.statSync(CLI).size)})`))
    assert.deepEqual(w.json(['log']).find(m => m.id.startsWith(plain))!.files, [])
    assert.doesNotMatch(w.ok(['read', again]), /Ringi-Files:/i)
    // Older commits retain changed-path semantics, including a carried tree on a text-only record.
    const head = w.git('rev-parse', 'refs/heads/r/log/operator')
    const old = w.git('commit-tree', w.git('rev-parse', `${head}^{tree}`), '-p', head, '-m', 'old plain\n\nTo: *')
    w.git('update-ref', 'refs/heads/r/log/operator', old, head)
    assert.deepEqual(w.json(['log']).find(m => m.id === old)!.files, [])
  })

  it('quarantines rewritten, deleted and foreign logs', (t) => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    w.ok(['join', 'local', 'r', '--as', 'codex'], {as: 'C'})
    w.ok(['agent', 'send', '--to', 'operator', '-m', 'one'], {as: 'C'})
    w.ok(['agent', 'send', '--to', 'operator', '-m', 'two'], {as: 'C'})
    assert.equal(w.json(['log']).length, 2)
    const ref = 'refs/heads/r/log/codex'
    const head = w.git('rev-parse', ref)
    w.git('update-ref', ref, `${head}^`)
    const rolled = w.run(['log'])
    assert.match(rolled.err, /ALARM log codex was rewritten/)
    assert.equal(rolled.out, '')
    w.git('update-ref', ref, head)
    assert.equal(w.json(['log']).length, 2)
    w.git('update-ref', '-d', ref)
    assert.match(w.run(['log']).err, /ALARM log codex was deleted/)
    w.git('update-ref', ref, head)
    // A log that does not descend from the room's genesis is never accepted.
    const stray = w.git('commit-tree', w.git('hash-object', '-w', '-t', 'tree', '--stdin'), '-m', 'stray\n\nTo: *')
    w.git('update-ref', 'refs/heads/r/log/mallory', stray)
    assert.match(w.run(['log']).err, /log mallory does not descend from the room's genesis/)
    w.git('update-ref', '-d', 'refs/heads/r/log/mallory')
    w.git('update-ref', ref, `${head}^`)
    assert.match(w.ok(['forget', 'r/codex']), /forgot the accepted history of r\/codex/)
    assert.deepEqual(w.json(['log']).map(m => m.subject), ['one'])
    assert.match(w.git('for-each-ref', 'refs/ringi/accepted/'), /\/operator\/codex/)
  })

  it('shows attachment sizes', (t) => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    w.ok(['join', 'local', 'r', '--as', 'codex'], {as: 'C'})
    w.ok(['send', '--to', 'codex', '-m', 'file', '--attach', `${CLI}:files/cli.js`])
    assert.match(w.ok(['agent', 'inbox'], {as: 'C'}), new RegExp(`Files: files/cli\\.js \\(${bytes(fs.statSync(CLI).size).replace('.', '\\.')}\\)`))
  })
})

describe('contracts and decisions', () => {
  it('accepts minor versions and refuses unknown contracts', (t) => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    assert.match(w.ok(['hub']), /\* local +git, asserted, contract 1\.1/)
    w.ok(['hub', 'amend', '-m', 'note', '--set', 'version=1.2'])
    assert.match(w.ok(['where']), /contract 1\.2/)
    w.ok(['hub', 'amend', '-m', 'teleport', '--set', 'capabilities=decisions/1,teleport/1'])
    w.no(['where'], /requires teleport\/1, which this ringi .* cannot enforce/)
    const w2 = world(t)
    w2.ok(['room', 'create', 'r'])
    w2.ok(['hub', 'amend', '-m', 'v2', '--set', 'version=2.0'])
    w2.no(['where'], /follows contract version 2\.0; this ringi .* supports 1\.x/)
    const w3 = world(t)
    fs.writeFileSync(path.join(w3.home, 'stray'), 'x')
    w3.no(['room', 'create', 'r'], /not a ringi home \(no home\.json\)/)
  })

  it('limits stamps and decisions to authorized participants', (t) => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    w.ok(['join', 'local', 'r', '--as', 'codex'], {as: 'C'})
    w.ok(['join', 'local', 'r', '--as', 'claude'], {as: 'L'})
    w.ok(['join', 'local', 'r', '--as', 'cursor'], {as: 'U'})
    const p = w.lastId(['agent', 'propose', '-m', 'Port the parser', '--decider', 'claude', '--reviewers', 'cursor', '--due', '2h', '--budget', 'runs=2,run-seconds=60'], {as: 'C'})
    assert.match(w.ok(['agent', 'inbox'], {as: 'L'}), /Kind: proposal[\s\S]*Decider: claude[\s\S]*Budget: runs=2, run-seconds=60, concurrency=1/)
    w.no(['agent', 'stamp', p, 'approve', '-m', 'yes'], /not a named reviewer/, {as: 'L'})
    w.ok(['agent', 'stamp', p, 'object', '-m', 'too broad'], {as: 'U'})
    w.ok(['agent', 'stamp', p, 'approve', '-m', 'fine now'], {as: 'U'})
    w.no(['agent', 'decide', p, 'approved', '-m', 'go'], /no authority/, {as: 'L'})
    // Authority comes from the hub contract, and a room follows the contract it was created under until moved.
    const auth = path.join(w.home, 'authority.json')
    fs.writeFileSync(auth, JSON.stringify({decide: {claude: {runs: 5, 'run-seconds': 900, concurrency: 1}, codex: {runs: 5}}}))
    w.ok(['hub', 'amend', '-m', 'claude may decide small work', '--authority', auth])
    w.no(['agent', 'decide', p, 'approved', '-m', 'go'], /no authority/, {as: 'L'})
    w.ok(['room', 'rebase-contract', 'r'])
    assert.match(w.ok(['agent', 'decide', p, 'approved', '-m', 'go'], {as: 'L'}), /grant \w+ with runs=2/)
    const [x] = w.json(['proposals', '--all'])
    assert.equal(x.state, 'approved')
    assert.deepEqual(x.stamps.cursor.stamp, 'approve')
    // Nobody decides their own proposal, however much authority they hold.
    const own = w.lastId(['agent', 'propose', '-m', 'Mine', '--decider', 'codex', '--budget', 'runs=1'], {as: 'C'})
    w.no(['agent', 'decide', own, 'approved', '-m', 'self'], /own proposal/, {as: 'C'})
    // A revision supersedes: the old one can no longer be decided.
    const v1 = w.lastId(['agent', 'propose', '-m', 'v1', '--decider', 'operator', '--budget', 'runs=1'], {as: 'C'})
    w.lastId(['agent', 'propose', '-m', 'v2', '--decider', 'operator', '--budget', 'runs=1', '--supersedes', v1], {as: 'C'})
    w.no(['decide', v1, 'approved', '-m', 'late'], /superseded/)
    assert.match(w.ok(['grants']), /active +runs 0\/2/)
  })

  it('judges decisions by their original control commit', (t) => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    w.ok(['join', 'local', 'r', '--as', 'codex'], {as: 'C'})
    w.ok(['join', 'local', 'r', '--as', 'claude'], {as: 'L'})
    const p = w.lastId(['agent', 'propose', '-m', 'Two runs', '--decider', 'claude', '--budget', 'runs=2'], {as: 'C'})
    const full = w.json(['log']).find(m => m.id.startsWith(p))!.id
    const forge = (control: string) => {
      const head = w.git('rev-parse', 'refs/heads/r/log/claude')
      const sha = w.git('commit-tree', w.git('rev-parse', `${head}^{tree}`), '-p', head, '-m', `approved\n\nTo: codex\nRe: ${full}\nKind: decision\nDecision: approved\nControl: ${control}`)
      w.git('update-ref', 'refs/heads/r/log/claude', sha, head)
    }
    w.ok(['agent', 'send', '--to', 'codex', '--re', full, '-m', 'thinking'], {as: 'L'})
    // An approval without authority, made under the room's current control commit.
    forge(w.git('rev-parse', 'refs/heads/r/control'))
    assert.equal(w.json(['proposals'])[0].state, 'open')
    // The operator gives claude authority on main; an approval naming that main commit, not a control commit, is void.
    const auth = path.join(w.home, 'authority.json')
    fs.writeFileSync(auth, JSON.stringify({decide: {claude: {runs: 5, 'run-seconds': 1800, concurrency: 1}}}))
    w.ok(['hub', 'amend', '-m', 'claude decides small work', '--authority', auth])
    forge(w.git('rev-parse', 'refs/heads/main'))
    assert.equal(w.json(['proposals'])[0].state, 'open')
    // Moving the room onto that contract endorses nothing that was written before.
    w.ok(['room', 'rebase-contract', 'r'])
    assert.equal(w.json(['proposals'])[0].state, 'open')
    assert.match(w.ok(['grants']), /no grants/)
    // A decision made now names the new control commit and counts.
    assert.match(w.ok(['agent', 'decide', p, 'approved', '-m', 'now with authority'], {as: 'L'}), /grant \w+ with runs=2/)
  })

  it('rejects zero runtime and concurrency budgets', (t) => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    w.no(['propose', '-m', 'x', '--decider', 'operator', '--budget', 'runs=1,run-seconds=0'], /--budget takes/)
    w.no(['propose', '-m', 'x', '--decider', 'operator', '--budget', 'runs=1,concurrency=0'], /--budget takes/)
  })

  it('ignores forged decisions', (t) => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    w.ok(['join', 'local', 'r', '--as', 'codex'], {as: 'C'})
    const p = w.lastId(['agent', 'propose', '-m', 'Budget please', '--decider', 'operator', '--budget', 'runs=9'], {as: 'C'})
    const full = w.json(['log']).find(m => m.id.startsWith(p))!.id
    // codex writes "approved" itself: it is not the decider.
    w.ok(['agent', 'send', '--to', 'operator', '--re', full, '-m', 'approved'], {as: 'C'})
    const head = w.git('rev-parse', 'refs/heads/r/log/codex')
    const tree = w.git('rev-parse', `${head}^{tree}`)
    const forged = w.git('commit-tree', tree, '-p', head, '-m', `approved\n\nTo: codex\nRe: ${full}\nKind: decision\nDecision: approved`)
    w.git('update-ref', 'refs/heads/r/log/codex', forged, head)
    assert.equal(w.json(['proposals'])[0].state, 'open')
    assert.match(w.ok(['grants']), /no grants/)
  })

  it('refuses work under revoked grants', (t) => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    w.ok(['join', 'local', 'r', '--as', 'codex'], {as: 'C'})
    w.ok(['leave'], {as: 'C'})
    const p = w.lastId(['propose', '-m', 'x', '--decider', 'operator', '--budget', 'runs=5'])
    const g = /grant (\w+)/.exec(w.ok(['decide', p, 'approved', '-m', 'go']))![1]
    w.ok(['decide', p, 'revoked', '-m', 'changed my mind'])
    w.no(['send', '--task', '--assign', 'codex', '--grant', g, '-m', 'x'], /revoked/)
    assert.match(w.ok(['grants']), /revoked/)
  })
})

describe('watchers', () => {
  it('keeps failed retries inside its own run budget and rejects invalid limits', t => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    w.ok(['join', 'local', 'r', '--as', 'codex'], {as: 'C'})
    w.ok(['leave'], {as: 'C'})
    w.ok(['send', '--task', '--assign', 'codex', '-m', 'work'])
    const watch = ['watch', 'r/codex', '--once', '--max-runs', '1']
    assert.equal(w.run([...watch, '--exec', 'exit 7']).code, 7)
    const retry = w.run([...watch, '--exec', 'echo OUTSIDE_BUDGET'])
    assert.equal(retry.code, 4)
    assert.doesNotMatch(retry.out, /OUTSIDE_BUDGET/)
    assert.match(retry.err, /own run budget spent/)
    for (const [option, value] of [['window', 'NaN'], ['interval', '0'], ['max-runs', 'Infinity'], ['max-hop', '-1']])
      w.no(['watch', 'r/codex', '--once', '--exec', 'true', `--${option}`, value], /must be.*seconds|must be.*integer/)
  })

  it('charges a failed granted attempt and its retry as separate runs', t => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    w.ok(['join', 'local', 'r', '--as', 'codex'], {as: 'C'})
    w.ok(['leave'], {as: 'C'})
    const p = w.lastId(['propose', '-m', 'two attempts', '--decider', 'operator', '--budget', 'runs=2,run-seconds=10'])
    const grant = /grant (\w+)/.exec(w.ok(['decide', p, 'approved', '-m', 'go']))![1]
    w.ok(['send', '--task', '--assign', 'codex', '--grant', grant, '-m', 'retry this work'])
    const inbox = `'${NODE}' '${CLI}' agent inbox --json`
    const watch = ['watch', 'r/codex', '--once', '--require-grant']
    assert.equal(w.run([...watch, '--exec', `${inbox}; exit 7`]).code, 7)
    assert.match(w.ok(['grants']), /runs 1\/2, open 0/)
    assert.match(w.ok([...watch, '--exec', inbox]), /retry this work/)
    assert.match(w.ok(['grants']), /runs 2\/2, open 0/)
    assert.doesNotMatch(w.ok([...watch, '--exec', 'echo DUPLICATE']), /DUPLICATE/)
    const receipts = w.json(['log', '--all', '-n', '100']).filter(m => m.kind === 'usage')
    assert.deepEqual(receipts.map(m => m.trailers.usage[0]), ['reserve', 'settle', 'reserve', 'settle'])
    assert.equal(receipts[1].trailers.exit[0], '7')
    assert.equal(receipts[3].trailers.exit[0], '0')
  })

  it('honors stop during the last grant read before dispatch', async (t) => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    w.ok(['join', 'local', 'r', '--as', 'codex'], {as: 'C'})
    w.ok(['leave'], {as: 'C'})
    const p = w.lastId(['propose', '-m', 'one turn', '--decider', 'operator', '--budget', 'runs=1,run-seconds=10'])
    const g = /grant (\w+)/.exec(w.ok(['decide', p, 'approved', '-m', 'go']))![1]
    w.ok(['send', '--task', '--assign', 'codex', '--grant', g, '-m', 'work'])
    const ready = path.join(w.home, 'ready'), resume = path.join(w.home, 'resume'), marker = path.join(w.home, 'started')
    const wrapper = path.join(w.home, 'watch.mjs')
    // Pause after the plan is saved, while dispatch rereads its grant. Stop must still win before spawn.
    fs.writeFileSync(wrapper, `import fs from 'node:fs';
      const read = fs.readFileSync; let paused = false;
      fs.readFileSync = function(file, ...args) {
        const data = read.call(fs, file, ...args);
        if (!paused && String(file).endsWith('/codex.json') && String(file).includes('/readers/') && JSON.parse(data).watched) {
          paused = true; fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
          const end = Date.now() + 10000;
          while (!fs.existsSync(${JSON.stringify(resume)}) && Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        }
        return data;
      };
      const {main} = await import(${JSON.stringify(pathToFileURL(CLI).href)}); await main(process.argv.slice(2));`)
    const child = spawn(NODE, [wrapper, 'watch', 'r/codex', '--once', '--require-grant', '--exec', `touch '${marker}'`], {env: {...BASE, RINGI_HOME: w.home}, stdio: 'ignore'})
    const exit = new Promise(resolve => child.once('exit', resolve))
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL') })
    await until(() => fs.existsSync(ready))
    const session = w.json(['sessions']).find(s => s.product === 'watch')!
    w.ok(['stop'], {as: session.handle.slice(4)})
    fs.writeFileSync(resume, 'resume')
    assert.equal(await exit, 0)
    assert.equal(fs.existsSync(marker), false)
    const receipt = w.json(['log', '--all', '-n', '100']).find(m => m.kind === 'usage' && m.trailers.usage[0] === 'settle')!
    assert.equal(receipt.trailers.seconds[0], '0')
    assert.equal(receipt.trailers.exit[0], '125')
  })

  it('ends every descendant with its turn', async (t) => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    w.ok(['join', 'local', 'r', '--as', 'codex'], {as: 'C'})
    w.ok(['leave'], {as: 'C'})
    const p = w.lastId(['propose', '-m', 'short', '--decider', 'operator', '--budget', 'runs=5,run-seconds=1'])
    const g = /grant (\w+)/.exec(w.ok(['decide', p, 'approved', '-m', 'go']))![1]
    const marker = (n: number) => path.join(w.home, `marker-${n}`)
    const task = (n: number) => w.ok(['send', '--task', '--assign', 'codex', '--grant', g, '-m', `turn ${n}`])
    // A background descendant that would write after the deadline.
    task(1)
    w.run(['watch', 'r/codex', '--once', '--exec', `(sleep 2; touch '${marker(1)}') & wait`])
    // A descendant left behind when the command itself exits at once.
    task(2)
    w.run(['watch', 'r/codex', '--once', '--exec', `(sleep 2; touch '${marker(2)}') & exit 0`])
    // A command that ignores SIGTERM is killed after the grace.
    task(3)
    const t0 = Date.now()
    const r = w.run(['watch', 'r/codex', '--once', '--exec', `trap '' TERM; sleep 30; touch '${marker(3)}'`])
    assert.ok(Date.now() - t0 < 15000, `took ${Date.now() - t0}ms`)
    assert.match(r.err, /stopped at the grant's run-seconds/)
    await new Promise(res => setTimeout(res, 3000))
    for (const n of [1, 2, 3]) assert.equal(fs.existsSync(marker(n)), false, `marker ${n} written after its turn ended`)
  })

  it('keeps living watchers in their seats and replaces dead watchers', async (t) => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    w.ok(['join', 'local', 'r', '--as', 'codex'], {as: 'C'})
    w.ok(['leave'], {as: 'C'})
    const first = spawn(NODE, [CLI, 'watch', 'r/codex', '--exec', 'true', '--interval', '1'], {env: {...BASE, RINGI_HOME: w.home}, stdio: 'ignore'})
    t.after(() => first.kill('SIGKILL'))
    let rec: Session | undefined
    for (let i = 0; i < 100 && !rec; i++) {
      await new Promise(res => setTimeout(res, 100))
      rec = w.json(['sessions']).find(s => s.product === 'watch')!
    }
    assert.ok(rec, 'the first watcher registered')
    const f = fs.readdirSync(path.join(w.home, 'sessions')).map(x => path.join(w.home, 'sessions', x)).find(x => JSON.parse(fs.readFileSync(x, 'utf8')).handle === rec!.handle)!
    fs.writeFileSync(f, JSON.stringify({...rec, lastSeen: '2020-01-01T00:00:00Z'}))
    w.no(['watch', 'r/codex', '--once', '--exec', 'true'], /held by session env:watch-local-\w+-codex-\d+ \(active\)/)
    first.kill('SIGKILL')
    await new Promise<void>(res => first.on('exit', () => res()))
    assert.equal(w.run(['watch', 'r/codex', '--once', '--exec', 'true']).code, 0)
  })

  it('checks stop and revocation between planned turns', async (t) => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    w.ok(['join', 'local', 'r', '--as', 'codex'], {as: 'C'})
    w.ok(['leave'], {as: 'C'})
    const grant = (n: number) => {
      const p = w.lastId(['propose', '-m', `grant ${n}`, '--decider', 'operator', '--budget', 'runs=1,run-seconds=10'])
      return /grant (\w+)/.exec(w.ok(['decide', p, 'approved', '-m', 'go']))![1]
    }
    const runs = path.join(w.home, 'runs')
    const watcher = () => spawn(NODE, [CLI, 'watch', 'r/codex', '--once', '--require-grant', '--exec', `echo RUN >> '${runs}'; sleep 1.5`], {env: {...BASE, RINGI_HOME: w.home}, stdio: 'ignore'})
    const started = () => fs.existsSync(runs) ? fs.readFileSync(runs, 'utf8').split('\n').filter(Boolean).length : 0
    // A stop during the first turn: the second does not start.
    for (const n of [1, 2]) w.ok(['send', '--task', '--assign', 'codex', '--grant', grant(n), '-m', `task ${n}`])
    let wt = watcher()
    await until(() => started() === 1)
    const handle = w.json(['sessions']).find(s => s.product === 'watch')!.handle
    w.ok(['stop'], {as: handle.replace(/^env:/, '')})
    await new Promise(res => wt.on('exit', res))
    assert.equal(started(), 1)
    assert.match(w.ok(['log', '--all', '-n', '100']), /not started: the watcher was stopped/)
    // A revocation during the first turn: the second does not start either.
    w.ok(['sessions', 'forget', handle])
    fs.rmSync(runs, {force: true})
    const g4 = grant(4)
    const p4 = w.json(['proposals', '--all']).find(x => x.subject === 'grant 4')!.id
    w.ok(['send', '--task', '--assign', 'codex', '--grant', grant(3), '-m', 'task 3'])
    w.ok(['send', '--task', '--assign', 'codex', '--grant', g4, '-m', 'task 4'])
    wt = watcher()
    await until(() => started() === 1)
    w.ok(['decide', p4, 'revoked', '-m', 'no'])
    await new Promise(res => wt.on('exit', res))
    assert.equal(started(), 1)
    assert.match(w.ok(['log', '--all', '-n', '100']), /not started: its grant was revoked/)
  })

  it('records grant usage, exhaustion and top-ups', (t) => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    w.ok(['join', 'local', 'r', '--as', 'codex'], {as: 'C'})
    w.ok(['leave'], {as: 'C'})
    const p = w.lastId(['propose', '-m', 'Two runs of codex', '--decider', 'operator', '--budget', 'runs=2,run-seconds=30'])
    const g = /grant (\w+)/.exec(w.ok(['decide', p, 'approved', '-m', 'go']))![1]
    w.ok(['send', '--task', '--assign', 'codex', '--grant', g, '-m', 'Port it'])
    const task = w.json(['tasks'])[0].id
    const exec = `'${NODE}' '${CLI}' agent whoami; echo "RUN grant=$RINGI_GRANT"`
    const watch = (more: string[] = []) => w.run(['watch', 'r/codex', '--exec', exec, '--once', ...more])
    let r = watch()
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /codex in local\/r[\s\S]*RUN grant=[0-9a-f]{40}/)
    assert.match(w.ok(['grants']), /runs 1\/2, open 0, \d+s used/)
    w.ok(['reply', task, '--to', 'codex', '-m', 'more'])
    assert.match(watch().out, /RUN/)
    w.ok(['reply', task, '--to', 'codex', '-m', 'and more'])
    r = watch()
    assert.doesNotMatch(r.out, /RUN/)
    assert.match(r.err, /grant \w+ is spent: 2\/2 runs/)
    assert.equal(w.json(['tasks'])[0].state, 'input-required')
    assert.match(w.ok(['grants']), /spent +runs 2\/2/)
    const receipts = w.json(['log', '--all', '-n', '50']).filter(m => m.kind === 'usage')
    assert.deepEqual(receipts.map(m => m.trailers.usage[0]), ['reserve', 'settle', 'reserve', 'settle'])
    const usage = w.json(['signals', '--all']).filter(s => s.signal.startsWith('usage.'))
    assert.equal(usage.length, 4)
    for (const m of receipts) assert.ok(usage.some(s => s.target === m.id && s.actor === m.from && s.signal === `usage.${m.trailers.usage[0]}` && s.ok))
    const before = w.ok(['grants'])
    w.git('update-ref', '-d', usage[0].ref)
    assert.match(w.run(['signals', '--all']).err, /ALARM.*signal.*removed/)
    assert.equal(w.ok(['grants']), before, 'a missing tag refunds no run')
    const watcher = w.json(['sessions']).find(s => s.product === 'watch')!
    const as = watcher.handle.replace(/^env:/, '')
    assert.match(w.ok(['agent', 'signals', '--repair'], {as}), /restored 1 signal/)
    assert.match(w.ok(['agent', 'signals', '--repair'], {as}), /restored 0 signal/)
    assert.equal(w.ok(['grants']), before, 'repair adds no spending')
    // A top-up is a new grant; the old ledger stays.
    const p2 = w.lastId(['propose', '-m', 'One more', '--decider', 'operator', '--budget', 'runs=1'])
    const g2 = /grant (\w+)/.exec(w.ok(['decide', p2, 'approved', '-m', 'ok']))![1]
    w.ok(['reply', task, '--to', 'codex', '--grant', g2, '-m', 'top-up'])
    assert.match(watch().out, new RegExp(`RUN grant=${g2}`))
    assert.match(w.ok(['grants']), /spent +runs 2\/2[\s\S]*spent +runs 1\/1/)
  })

  it('enforces run-seconds and --require-grant', (t) => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    w.ok(['join', 'local', 'r', '--as', 'codex'], {as: 'C'})
    w.ok(['leave'], {as: 'C'})
    const p = w.lastId(['propose', '-m', 'short', '--decider', 'operator', '--budget', 'runs=3,run-seconds=1'])
    const g = /grant (\w+)/.exec(w.ok(['decide', p, 'approved', '-m', 'go']))![1]
    w.ok(['send', '--task', '--assign', 'codex', '--grant', g, '-m', 'slow'])
    const r = w.run(['watch', 'r/codex', '--exec', 'sleep 5', '--once'])
    assert.match(r.err, /stopped at the grant's run-seconds/)
    const settle = w.json(['log', '--all']).find(m => m.kind === 'usage' && m.trailers.usage[0] === 'settle')!
    assert.ok(Number(settle.trailers.seconds[0]) <= 3, settle.trailers.seconds[0])
    w.ok(['send', '--to', 'codex', '-m', 'no grant here'])
    const r2 = w.run(['watch', 'r/codex', '--exec', 'echo RUN', '--once', '--require-grant'])
    assert.doesNotMatch(r2.out, /RUN/)
    assert.match(r2.err, /outside any grant; --require-grant/)
  })

  it('answers pings once without waking a model for broadcasts', (t) => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    w.ok(['join', 'local', 'r', '--as', 'codex'], {as: 'C'})
    w.ok(['leave'], {as: 'C'})
    w.ok(['join', 'local', 'r', '--as', 'claude'], {as: 'L'})
    assert.match(w.run(['send', '-m', 'hello all']).err, /wakes nobody/)
    const watch = () => w.run(['watch', 'r/codex', '--exec', 'echo RUN', '--once'])
    assert.doesNotMatch(watch().out, /RUN/)
    w.ok(['agent', 'ping', 'codex', '-m', 'ping: halfway'], {as: 'L'})
    let r = watch()
    assert.doesNotMatch(r.out, /RUN/)
    assert.match(r.err, /answered heartbeat/)
    assert.doesNotMatch(watch().err, /answered heartbeat/)
    assert.match(w.ok(['agent', 'ping', 'codex'], {as: 'L'}), /codex answered the previous one/)
    assert.match(w.ok(['agent', 'inbox'], {as: 'L'}), /hello all/)
    // The watcher holds the seat: a chat cannot join as codex while it runs.
    w.no(['join', 'local', 'r', '--as', 'codex'], /held by another session \(env:watch-local-\w+-codex/, {as: 'C'})
    r = w.run(['sessions', 'forget', w.json(['sessions']).find(s => s.product === 'watch')!.handle])
    assert.equal(r.code, 0, r.err)
  })
})

describe('state and locks', () => {
  it('serializes competing processes after recovering a dead owner', async (t) => {
    const w = world(t)
    const file = path.join(w.home, 'shared.lock'), count = path.join(w.home, 'count')
    fs.writeFileSync(file, '999999.dead')
    fs.writeFileSync(count, '0')
    const code = `import fs from 'node:fs';
      import {locked} from ${JSON.stringify(pathToFileURL(path.join(HERE, '../../../target/esm/lib/index.js')).href)};
      for (let i = 0; i < 10; i++) locked(${JSON.stringify(file)}, () => {
        const n = Number(fs.readFileSync(${JSON.stringify(count)}, 'utf8'));
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
        fs.writeFileSync(${JSON.stringify(count)}, String(n + 1));
      });`
    const children = Array.from({length: 4}, () => spawn(NODE, ['--input-type=module', '-e', code], {env: BASE, stdio: 'ignore', timeout: 10000}))
    t.after(() => children.forEach(child => { if (child.exitCode === null) child.kill('SIGKILL') }))
    const codes = await Promise.all(children.map(child => new Promise(resolve => child.once('exit', resolve))))
    assert.deepEqual(codes, [0, 0, 0, 0])
    assert.equal(fs.readFileSync(count, 'utf8'), '40')
    assert.equal(fs.existsSync(file), false)
    assert.equal(fs.existsSync(file + '.recover'), false)
  })

  it('preserves abandoned, live and unknown recovery gates', (t) => {
    const w = world(t)
    const file = path.join(w.home, 'shared.lock'), gate = file + '.recover'
    fs.writeFileSync(file, '999999.dead')
    for (const token of ['999998.dead', `${process.pid}.live`, '']) {
      fs.writeFileSync(gate, token)
      assert.throws(() => locked(file, () => assert.fail('entered a blocked lock'), 25), /abandoned|held/)
      assert.equal(fs.readFileSync(gate, 'utf8'), token)
      assert.equal(fs.readFileSync(file, 'utf8'), '999999.dead')
    }
  })

  for (const [owner, token] of [['live', `${process.pid}.test`], ['unknown', '']]) {
    it(`preserves ${owner} owners regardless of lock age`, (t) => {
      const w = world(t)
      w.ok(['room', 'create', 'r'])
      w.ok(['join', 'local', 'r', '--as', 'codex'], {as: 'C'})
      const lock = path.join(w.home, 'locks', 'sessions.lock')
      fs.writeFileSync(lock, token)
      fs.utimesSync(lock, new Date(0), new Date(0))
      const r = spawnSync(NODE, [CLI, 'agent', 'whoami'], {encoding: 'utf8', timeout: 2000, env: {...BASE, RINGI_HOME: w.home, RINGI_SESSION: 'C'}})
      assert.equal(r.signal, 'SIGTERM', `waited for ${owner} owner: ${r.stderr}`)
      assert.equal(fs.readFileSync(lock, 'utf8'), token)
    })
  }

  it('recovers dead lock owners', (t) => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    w.ok(['join', 'local', 'r', '--as', 'codex'], {as: 'C'})
    const lock = path.join(w.home, 'locks', 'sessions.lock')
    fs.writeFileSync(lock, '999999.dead')
    assert.match(w.ok(['agent', 'whoami'], {as: 'C'}), /codex in local\/r/)
  })

  it('explains sandbox write failures', (t) => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    w.ok(['join', 'local', 'r', '--as', 'codex'], {as: 'C'})
    fs.chmodSync(path.join(w.home, 'locks'), 0o500)
    const err = w.no(['agent', 'inbox'], /cannot write/, {as: 'C'})
    assert.match(err, /re-run this same command with your host's sandbox escalation/)
    assert.match(err, /writable_roots/)
    fs.chmodSync(path.join(w.home, 'locks'), 0o700)
  })
})

describe('CLI reference', () => {
  it('generates COMMANDS.md from the command table', () => {
    const md = spawnSync(NODE, [CLI, 'help', '--md'], {encoding: 'utf8', env: BASE}).stdout
    assert.equal(fs.readFileSync(path.join(HERE, '../../../COMMANDS.md'), 'utf8'), md, 'run: npm run commands')
    for (const c of ['join <hub> <room>', 'continue', 'stop', 'leave', 'where', 'agent inbox', 'propose', 'watch']) assert.ok(md.includes(`ringi ${c}`), c)
  })
})
