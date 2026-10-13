// The coordination model as data: task profiles, role labels without built-in meaning, signals beside the messages,
// hub descriptors and stores, and the move of an older home.
import {describe, it} from 'node:test'
import type {TestContext} from 'node:test'
import type {asJson} from '../../main/ts/core/hub/usecases/view.ts'
import type {Checked} from '../../main/ts/core/hub/signals/index.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {BASE, BIN, FIXTURE_GIT, shellBin} from './cli.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// These cases go through the command line only (RINGI_BIN, see cli.ts), so they are a conformance suite for a port.

type RunOpt = {as?: string}
const find = <T>(xs: T[], hit: (x: T) => boolean): T => xs.find(hit) ?? assert.fail('the expected entry is listed')
type TaskView = {id: string, subject: string, requester: string, assignees: string[], roles: Record<string, string>,
  taken: string[], state: string, by: string, at: string}

const world = (t: TestContext) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ringi-model-'))
  t.after(() => fs.rmSync(home, {recursive: true, force: true}))
  const run = (args: string[], {as}: RunOpt = {}) => {
    const r = spawnSync(BIN[0], [...BIN.slice(1), ...args], {encoding: 'utf8', env: {...BASE, RINGI_HOME: home, ...(as ? {RINGI_SESSION: as} : {})}})
    return {code: r.status, out: r.stdout, err: r.stderr}
  }
  const ok = (args: string[], opt?: RunOpt) => {
    const r = run(args, opt)
    assert.equal(r.code, 0, `ringi ${args.join(' ')}: ${r.err}`)
    return r.out
  }
  const no = (args: string[], re: RegExp, opt?: RunOpt) => {
    const r = run(args, opt)
    assert.notEqual(r.code, 0, `ringi ${args.join(' ')} should fail: ${r.out}`)
    assert.match(r.err, re)
  }
  function json(args: ['log', ...string[]], opt?: RunOpt): ReturnType<typeof asJson>[]
  function json(args: ['tasks', ...string[]], opt?: RunOpt): TaskView[]
  function json(args: ['signals', ...string[]], opt?: RunOpt): Checked[]
  function json(args: string[], opt?: RunOpt): unknown { return JSON.parse(ok([...args, '--json'], opt)) }
  // Room r's repository, and the contract's (hub-2: one repository per room beside the contract's).
  const repo = path.join(home, 'hub', 'local', 'rooms', 'r', 'store', '.git')
  const git = (...args: string[]) => spawnSync('git', ['--git-dir', repo, ...args], {encoding: 'utf8', env: FIXTURE_GIT}).stdout.trim()
  const contractGit = (...args: string[]) => spawnSync('git', ['--git-dir', path.join(home, 'hub', 'local', 'contract', '.git'), ...args], {encoding: 'utf8', env: FIXTURE_GIT}).stdout.trim()
  const genesis = () => git('rev-list', '--reverse', 'refs/heads/chat', '^refs/heads/main').split('\n')[0]
  const control = () => git('log', '-1', '--first-parent', '--format=%H', '--author=^operator ', '--grep=^Kind: room$', 'refs/heads/chat')
  // A record on `actor`'s signals, written past ringi: these fields, on the stream's tip or the room's genesis.
  const record = (actor: string, fields: Array<[string, string]>): string => {
    const ref = `refs/heads/${actor}/signals`, parent = git('rev-parse', '-q', '--verify', ref) || genesis()
    const env = {...FIXTURE_GIT, GIT_AUTHOR_NAME: actor, GIT_AUTHOR_EMAIL: `${actor}@ringi`, GIT_COMMITTER_NAME: actor, GIT_COMMITTER_EMAIL: `${actor}@ringi`}
    const r = spawnSync('git', ['--git-dir', repo, 'commit-tree', `${parent}^{tree}`, '-p', parent], {encoding: 'utf8', env, input: fields.map(([k, v]) => `${k}: ${v}`).join('\n') + '\n'})
    assert.equal(r.status, 0, r.stderr)
    git('update-ref', ref, r.stdout.trim())
    return r.stdout.trim()
  }
  const id = (out: string) => /(?:sent|proposed) ([0-9a-f]{12})/.exec(out)![1]
  const file = (name: string, v: unknown) => {
    const f = path.join(home, name)
    fs.writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v))
    return f
  }
  return {home, run, ok, no, json, git, contractGit, genesis, control, record, id, file}
}
// A review flow nobody built into ringi: a writer opens, a reviewer approves or sends back, only the writer ships.
const REVIEW = {
  schema: 'ringi-profile/1',
  name: 'review-1',
  description: 'write, review, ship',
  opens: 'change',
  states: ['draft', 'in-review', 'approved', 'changes', 'shipped', 'dropped'],
  initial: 'draft',
  terminal: ['shipped', 'dropped'],
  waiting: 'changes',
  rules: {
    assign: ['requester', 'role:architect'],
    roles: ['requester'],
    'state:in-review': ['assignee'],
    'state:approved': ['role:reviewer'],
    'state:changes': ['role:reviewer'],
    'state:shipped': ['assignee'],
    'state:dropped': ['requester', 'agent:hermes'],
  },
}

describe('profiles: what a piece of work is, as data', () => {
  it('lets a hub carry its own profile and a room follow it, with labels that mean only what the profile says', (t) => {
    const w = world(t)
    w.ok(['hub'])
    w.no(['room', 'create', 'x', '--profile', 'review-1'], /carries no profile review-1/)
    w.ok(['hub', 'amend', '-m', 'our review flow', '--attach', `${w.file('review.json', REVIEW)}:profiles/review-1.json`])
    w.ok(['room', 'create', 'feature', '--profile', 'review-1'])
    for (const [as, who] of [['W', 'writer'], ['V', 'reviewer'], ['H', 'hermes']]) w.ok(['join', 'feature', '--as', who], {as})
    assert.match(w.ok(['profile']), /follows profile review-1: write, review, ship[\s\S]*opens with Kind: change; states: draft, in-review, approved, changes, shipped, dropped/)
    const c = w.id(w.ok(['send', '--task', '--assign', 'writer', '--roles', 'reviewer=reviewer', '-m', 'Add the login page']))
    w.no(['reply', c, '--state', 'done', '-m', 'x'], /--state must be one of profile review-1: draft, in-review/)
    assert.equal(w.json(['tasks'])[0].state, 'draft')
    // Each step answers the message it acts on: only these links order replies across logs.
    const ready = w.id(w.ok(['agent', 'reply', c, '--state', 'in-review', '-m', 'ready'], {as: 'W'}))
    // The writer cannot approve its own change: only role:reviewer may.
    const self = w.id(w.ok(['agent', 'reply', ready, '--state', 'approved', '-m', 'self-approval'], {as: 'W'}))
    assert.equal(w.json(['tasks'])[0].state, 'in-review')
    const approved = w.id(w.ok(['agent', 'reply', self, '--state', 'approved', '-m', 'looks good'], {as: 'V'}))
    assert.equal(w.json(['tasks'])[0].state, 'approved')
    w.ok(['agent', 'reply', approved, '--state', 'shipped', '-m', 'shipped'], {as: 'W'})
    const [task] = w.json(['tasks', '--all'])
    assert.deepEqual([task.state, task.by, task.roles], ['shipped', 'writer', {reviewer: 'reviewer'}])
    // A label called lead means nothing here: it grants no assignment.
    w.ok(['agent', 'send', '--to', 'writer', '--task', '--assign', 'writer', '--roles', 'hermes=lead', '-m', 'Second change'], {as: 'V'})
    const change = () => find(w.json(['tasks', '--all']), x => x.subject === 'Second change')
    const second = change()
    w.ok(['agent', 'reply', second.id, '--assign', 'hermes', '-m', 'mine now'], {as: 'H'})
    assert.deepEqual(change().assignees, ['writer'])
    // An explicit agent principal: hermes may drop any change.
    w.ok(['agent', 'reply', second.id, '--state', 'dropped', '-m', 'not needed'], {as: 'H'})
    assert.equal(change().state, 'dropped')
  })

  it('judges every right on the work as it was before the message', (t) => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    for (const [as, who] of [['A', 'alice'], ['B', 'bob']]) w.ok(['join', 'r', '--as', who], {as})
    const task = w.id(w.ok(['send', '--task', '--assign', 'alice', '-m', 'Job']))
    // bob makes himself lead and reassigns in the same message: the label was not his before, so nothing changes.
    w.ok(['agent', 'reply', task, '--roles', 'bob=lead', '--assign', 'bob', '--state', 'completed', '-m', 'mine'], {as: 'B'})
    const [x] = w.json(['tasks', '--all'])
    assert.deepEqual([x.assignees, x.roles, x.state], [['alice'], {}, 'submitted'])
  })

  it('keeps a room on the profile it was made with when the hub changes its profiles', (t) => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    w.ok(['join', 'r', '--as', 'alice'], {as: 'A'})
    const task = w.id(w.ok(['send', '--task', '--assign', 'alice', '-m', 'Job']))
    w.ok(['agent', 'reply', task, '--state', 'completed', '-m', 'done'], {as: 'A'})
    // The hub's a2a-1 is replaced by one where assignees may not complete: the room's history stays as it was.
    const strict = JSON.parse(fs.readFileSync(path.join(HERE, '../../main/resources/profiles/a2a-1.json'), 'utf8'))
    strict.rules['state:completed'] = ['requester']
    w.ok(['hub', 'amend', '-m', 'stricter', '--attach', `${w.file('strict.json', strict)}:profiles/a2a-1.json`])
    assert.equal(w.json(['tasks', '--all'])[0].state, 'completed')
    w.ok(['room', 'create', 'r2'])
    assert.match(w.ok(['profile', '--room', 'r2', '--json']), /"state:completed": \[\s*"requester"\s*\]/)
  })

  it('declares profiles/1, so that a client without profiles refuses the hub instead of misreading it', (t) => {
    const w = world(t)
    w.ok(['hub'])
    assert.match(w.contractGit('show', 'main:contract.json'), /"profiles\/1"/)
    w.ok(['hub', 'amend', '-m', 'drop it', '--set', 'capabilities='])
    assert.doesNotMatch(w.contractGit('show', 'main:contract.json'), /"profiles\/1"/)
    w.ok(['hub', 'amend', '-m', 'our flow', '--attach', `${w.file('review.json', REVIEW)}:profiles/review-1.json`])
    assert.match(w.contractGit('show', 'main:contract.json'), /"profiles\/1"/)
  })

  it('refuses a malformed profile before it reaches the contract', (t) => {
    const w = world(t)
    w.ok(['hub'])
    const cases: [unknown, RegExp][] = [
      [{...REVIEW, initial: 'nowhere'}, /`initial` must be one of the states/],
      [{...REVIEW, rules: {'state:approved': ['reviewer']}}, /must list principals/],
      [{...REVIEW, rules: {'state:merged': ['assignee']}}, /names an unknown state/],
      [{...REVIEW, schema: 'ringi-profile/9'}, /schema ringi-profile\/9/],
    ]
    for (const [bad, re] of cases) w.no(['hub', 'amend', '-m', 'bad', '--attach', `${w.file('bad.json', bad)}:profiles/bad-1.json`], re)
    w.no(['hub', 'amend', '-m', 'dup', '--attach', `${w.file('dup.json', '{"schema": "ringi-profile/1", "schema": "x"}')}:profiles/dup-1.json`], /duplicate JSON field/)
  })
})

describe('signals: what happened, beside the messages', () => {
  it('marks only transitions the work actually counted, in the author\'s own namespace', (t) => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    for (const [as, who] of [['A', 'alice'], ['B', 'bob']]) w.ok(['join', 'r', '--as', who], {as})
    const task = w.id(w.ok(['send', '--task', '--assign', 'alice', '-m', 'Job']))
    w.ok(['agent', 'reply', task, '--state', 'working', '-m', 'on it'], {as: 'A'})
    // bob is no assignee: his State is in his message but makes no signal.
    w.ok(['agent', 'reply', task, '--state', 'completed', '-m', 'done (not mine)'], {as: 'B'})
    w.ok(['agent', 'reply', task, '--state', 'completed', '-m', 'done'], {as: 'A'})
    const sig = w.json(['signals'])
    assert.deepEqual(sig.map(s => `${s.actor}:${s.signal}`).sort(), ['alice:state.completed', 'alice:state.working', 'operator:assigned', 'operator:opened'])
    assert.ok(sig.every(s => s.ok))
    assert.match(w.git('log', '--format=%B', 'refs/heads/alice/signals'), /^Signal: state\.completed$/m)
    // A signal is a record of its actor's stream: its room, its control, its message and itself, nothing else.
    const opened = w.git('log', '-1', '--format=%an <%ae>%n%B', '--grep=^Signal: opened$', 'refs/heads/operator/signals')
    assert.match(opened, new RegExp(`^operator <operator@ringi>\\nRoom: ${w.genesis()}\\nControl: [0-9a-f]{40}\\nTarget: ${find(sig, s => s.signal === 'opened').target}\\nSignal: opened\\n*$`))
  })

  it('alarms on a signal that disagrees with its message, or that changes or disappears after it was accepted', (t) => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    w.ok(['join', 'r', '--as', 'alice'], {as: 'A'})
    const task = w.id(w.ok(['send', '--task', '--assign', 'alice', '-m', 'Job']))
    const full = find(w.json(['log']), m => m.id.startsWith(task)).id
    assert.equal(w.run(['signals']).err, '')
    const at = (signal: string): Array<[string, string]> => [['Room', w.genesis()], ['Control', w.control()], ['Target', full], ['Signal', signal]]
    // A forged signal: alice claims a completion her message never made.
    w.record('alice', at('state.completed'))
    assert.match(w.run(['signals']).err, /ALARM signal alice state\.completed [0-9a-f]{12}: points at a message of operator/)
    w.git('update-ref', '-d', 'refs/heads/alice/signals')
    // A record that says more than a signal is not one.
    w.record('alice', [...at('read'), ['Note', 'more']])
    assert.match(w.run(['signals']).err, /ALARM signal stream alice: [0-9a-f]{12}: unknown stream fact/)
    w.git('update-ref', '-d', 'refs/heads/alice/signals')
    // An accepted stream rewritten, then removed.
    const ref = 'refs/heads/operator/signals', accepted = w.git('rev-parse', ref)
    w.git('update-ref', ref, w.git('commit-tree', `${accepted}^{tree}`, '-p', `${accepted}^`, '-m', 'Room: x'))
    assert.match(w.run(['signals']).err, new RegExp(`ALARM signal stream operator does not include its accepted prefix ${accepted}`))
    w.git('update-ref', '-d', ref)
    assert.match(w.run(['signals']).err, /signal stream operator was removed after it was accepted/)
  })

  it('restores the missing signals of one\'s own messages', (t) => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    w.ok(['send', '--task', '--assign', 'alice', '-m', 'Job'])
    w.git('update-ref', '-d', 'refs/heads/operator/signals')
    assert.match(w.ok(['signals']), /no signals/)
    assert.match(w.ok(['signals', '--repair']), /restored 2 signal\(s\) of operator/)
    assert.deepEqual(w.json(['signals']).map(s => s.signal).sort(), ['assigned', 'opened'])
  })
})

describe('marks: the second layer, where attention is', () => {
  it('leaves a read mark on delivery and a taken mark on demand, and shows them; neither changes the work', (t) => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    for (const [as, who] of [['A', 'alice'], ['B', 'bob']]) w.ok(['join', 'r', '--as', who], {as})
    const task = w.id(w.ok(['send', '--task', '--to', 'alice,bob', '--assign', 'alice', '-m', 'Job']))
    w.ok(['agent', 'inbox', '--peek'], {as: 'B'})
    assert.doesNotMatch(w.ok(['read', task]), /read by/)
    w.ok(['agent', 'inbox'], {as: 'A'})
    w.ok(['agent', 'inbox'], {as: 'B'})
    assert.match(w.ok(['read', task]), /read by: alice, bob/)
    assert.match(w.ok(['agent', 'take', task], {as: 'A'}), /took /)
    assert.match(w.ok(['agent', 'take', task], {as: 'A'}), /already took/)
    const [x] = w.json(['tasks'])
    assert.deepEqual([x.state, x.assignees, x.taken], ['submitted', ['alice'], ['alice']])
    assert.match(w.ok(['tasks']), /taken by alice/)
    assert.match(w.ok(['read', task]), /taken by: alice/)
    const kinds = w.json(['signals']).map(s => `${s.actor}:${s.signal}`).sort()
    assert.deepEqual(kinds, ['alice:read', 'alice:taken', 'bob:read', 'operator:assigned', 'operator:opened'])
    assert.ok(w.json(['signals']).every(s => s.ok))
  })

  it('refuses impossible marks, and alarms on a forged one', (t) => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    for (const [as, who] of [['A', 'alice'], ['B', 'bob']]) w.ok(['join', 'r', '--as', who], {as})
    const note = w.id(w.ok(['send', '--to', 'alice', '-m', 'just a note']))
    w.no(['agent', 'take', note], /does not open work/, {as: 'A'})
    const full = find(w.json(['log']), m => m.id.startsWith(note)).id
    // bob marks as read a message addressed to alice only.
    w.record('bob', [['Room', w.genesis()], ['Control', w.control()], ['Target', full], ['Signal', 'read']])
    assert.match(w.run(['signals']).err, /ALARM signal bob read [0-9a-f]{12}: .*not delivered to bob/)
  })
})

describe('hubs: a descriptor beside a store', () => {
  it('ends quietly when its reader closes the pipe early', () => {
    // `true` exits without reading, so every write of ringi meets a closed pipe.
    const r = spawnSync('sh', ['-c', `${shellBin} help | true`], {encoding: 'utf8', env: BASE})
    assert.equal(r.status, 0)
    assert.doesNotMatch(r.stderr, /EPIPE|Unhandled/)
  })

  it('enforces one major of each capability a contract selects', (t) => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    w.no(['hub', 'amend', '-m', 'two majors', '--set', 'capabilities=profiles/1,profiles/2'], /selects two majors of profiles, which this ringi .* cannot enforce/)
  })

  it('refuses a room\'s history offered under another name', (t) => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    w.ok(['send', '--to', '*', '-m', 'only in r'])
    // An endpoint named `other` that points at r's history.
    const rooms = path.join(w.home, 'hub', 'local', 'rooms')
    fs.cpSync(path.join(rooms, 'r'), path.join(rooms, 'other'), {recursive: true})
    const e = path.join(rooms, 'other', 'endpoint.json')
    fs.writeFileSync(e, JSON.stringify({...JSON.parse(fs.readFileSync(e, 'utf8')), name: 'other'}))
    const list = w.run(['room', 'list'])
    assert.equal(list.code, 0, list.err)
    assert.match(list.out, /^\* r +1 member/m)
    assert.doesNotMatch(list.out, /other/)
    assert.match(list.err, /ALARM room other: its genesis is "room r"/)
    w.no(['log', '--room', 'other'], /its genesis is "room r"; refusing a room's history under another name/)
    assert.match(w.ok(['log', '--room', 'r']), /only in r/)
  })

  it('keeps what this machine knows in hub.json and the shared contract in the store', (t) => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    const d = JSON.parse(fs.readFileSync(path.join(w.home, 'hub', 'local', 'hub.json'), 'utf8'))
    assert.deepEqual(d, {schema: 'ringi-hub/3', name: 'local', trust: 'asserted', genesis: w.contractGit('rev-list', '--max-parents=0', 'main'), store: {type: 'git'}, contract: {path: 'contract'}})
    assert.deepEqual(w.contractGit('ls-tree', '-r', '--name-only', 'main').split('\n'), ['HUB.md', 'contract.json', 'profiles/a2a-1.json'])
    assert.match(w.contractGit('show', 'main:contract.json'), /"profile": "a2a-1"/)
    // The room's repository holds the contract's history and its own chat; the hub's genesis is their common root.
    assert.equal(w.git('rev-list', '--max-parents=0', 'chat'), d.genesis)
  })

  it('refuses a store type it does not know', (t) => {
    const w = world(t)
    w.ok(['hub'])
    const f = path.join(w.home, 'hub', 'local', 'hub.json')
    const d = JSON.parse(fs.readFileSync(f, 'utf8'))
    fs.writeFileSync(f, JSON.stringify({...d, store: {type: 'teleport'}}))
    w.no(['room', 'create', 'r'], /hub local uses a teleport store; this ringi .* knows git/)
  })

})
