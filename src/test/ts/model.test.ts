// The coordination model as data: task profiles, role labels without built-in meaning, signals beside the messages,
// hub descriptors and stores, and the move of an older home.
import {describe, it} from 'node:test'
import type {TestContext} from 'node:test'
import type {Session} from '../../main/ts/runtime/session.ts'
import type {asJson} from '../../main/ts/app/view.ts'
import type {Checked} from '../../main/ts/domain/signals.ts'
import type {Budget, Usage} from '../../main/ts/domain/decisions.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {fileURLToPath, pathToFileURL} from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(HERE, '../../../target/esm/cli.js')
const BASE = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|CODEX|CURSOR|RINGI_|GIT_)/.test(k)))

type RunOpt = {as?: string}
const find = <T>(xs: T[], hit: (x: T) => boolean): T => xs.find(hit) ?? assert.fail('the expected entry is listed')
type TaskView = {id: string, subject: string, requester: string, assignees: string[], roles: Record<string, string>,
  taken: string[], grant: string | null, state: string, by: string, at: string}
type GrantView = {grant: string, proposal: string, budget: Budget, revoked: boolean, usage: Usage}

const world = (t: TestContext) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ringi-model-'))
  t.after(() => fs.rmSync(home, {recursive: true, force: true}))
  const run = (args: string[], {as}: RunOpt = {}) => {
    const r = spawnSync(process.execPath, [CLI, ...args], {encoding: 'utf8', env: {...BASE, RINGI_HOME: home, ...(as ? {RINGI_SESSION: as} : {})}})
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
  function json(args: ['sessions', ...string[]], opt?: RunOpt): Session[]
  function json(args: ['signals', ...string[]], opt?: RunOpt): Checked[]
  function json(args: ['grants', ...string[]], opt?: RunOpt): GrantView[]
  function json(args: string[], opt?: RunOpt): unknown { return JSON.parse(ok([...args, '--json'], opt)) }
  const store = path.join(home, 'hub', 'local', 'store', '.git')
  const git = (...args: string[]) => spawnSync('git', ['--git-dir', store, ...args], {encoding: 'utf8'}).stdout.trim()
  const id = (out: string) => /(?:sent|proposed) ([0-9a-f]{12})/.exec(out)![1]
  const file = (name: string, v: unknown) => {
    const f = path.join(home, name)
    fs.writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v))
    return f
  }
  return {home, run, ok, no, json, git, id, file}
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
    for (const [as, who] of [['W', 'writer'], ['V', 'reviewer'], ['H', 'hermes']]) w.ok(['join', 'local', 'feature', '--as', who], {as})
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
    for (const [as, who] of [['A', 'alice'], ['B', 'bob']]) w.ok(['join', 'local', 'r', '--as', who], {as})
    const task = w.id(w.ok(['send', '--task', '--assign', 'alice', '-m', 'Job']))
    // bob makes himself lead and reassigns in the same message: the label was not his before, so nothing changes.
    w.ok(['agent', 'reply', task, '--roles', 'bob=lead', '--assign', 'bob', '--state', 'completed', '-m', 'mine'], {as: 'B'})
    const [x] = w.json(['tasks', '--all'])
    assert.deepEqual([x.assignees, x.roles, x.state], [['alice'], {}, 'submitted'])
  })

  it('keeps a room on the profile it was made with when the hub changes its profiles', (t) => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    w.ok(['join', 'local', 'r', '--as', 'alice'], {as: 'A'})
    const task = w.id(w.ok(['send', '--task', '--assign', 'alice', '-m', 'Job']))
    w.ok(['agent', 'reply', task, '--state', 'completed', '-m', 'done'], {as: 'A'})
    // The hub's a2a-1 is replaced by one where assignees may not complete: the room's history stays as it was.
    const strict = JSON.parse(fs.readFileSync(path.join(HERE, '../../main/resources/profiles/a2a-1.json'), 'utf8'))
    strict.rules['state:completed'] = ['requester']
    w.ok(['hub', 'amend', '-m', 'stricter', '--attach', `${w.file('strict.json', strict)}:profiles/a2a-1.json`])
    w.ok(['room', 'rebase-contract', 'r'])
    assert.equal(w.json(['tasks', '--all'])[0].state, 'completed')
    w.ok(['room', 'create', 'r2'])
    assert.match(w.ok(['profile', '--room', 'r2', '--json']), /"state:completed": \[\s*"requester"\s*\]/)
  })

  it('declares profiles/1, so that a client without profiles refuses the hub instead of misreading it', (t) => {
    const w = world(t)
    w.ok(['hub'])
    assert.match(w.git('show', 'main:contract.json'), /"profiles\/1"/)
    w.ok(['hub', 'amend', '-m', 'drop it', '--set', 'capabilities=decisions/1'])
    assert.doesNotMatch(w.git('show', 'main:contract.json'), /"profiles\/1"/)
    w.ok(['hub', 'amend', '-m', 'our flow', '--attach', `${w.file('review.json', REVIEW)}:profiles/review-1.json`])
    assert.match(w.git('show', 'main:contract.json'), /"profiles\/1"/)
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
    for (const [as, who] of [['A', 'alice'], ['B', 'bob']]) w.ok(['join', 'local', 'r', '--as', who], {as})
    const task = w.id(w.ok(['send', '--task', '--assign', 'alice', '-m', 'Job']))
    w.ok(['agent', 'reply', task, '--state', 'working', '-m', 'on it'], {as: 'A'})
    // bob is no assignee: his State is in his message but makes no signal.
    w.ok(['agent', 'reply', task, '--state', 'completed', '-m', 'done (not mine)'], {as: 'B'})
    w.ok(['agent', 'reply', task, '--state', 'completed', '-m', 'done'], {as: 'A'})
    const sig = w.json(['signals'])
    assert.deepEqual(sig.map(s => `${s.actor}:${s.signal}`).sort(), ['alice:state.completed', 'alice:state.working', 'operator:assigned', 'operator:opened'])
    assert.ok(sig.every(s => s.ok))
    const genesis = w.json(['sessions'])[0].genesis
    assert.match(w.git('tag', '-l', `ringi/${genesis}/alice/*`), new RegExp(`^ringi/${genesis}/alice/[0-9a-f]{40}\\.state\\.completed$`, 'm'))
    assert.match(w.git('cat-file', '-p', `ringi/${genesis}/operator/${find(sig, s => s.signal === 'opened').target}.opened`), /^tagger operator [\s\S]*Room: r\n/m)
  })

  it('alarms on a signal that disagrees with its message, or that changes or disappears after it was accepted', (t) => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    w.ok(['join', 'local', 'r', '--as', 'alice'], {as: 'A'})
    const task = w.id(w.ok(['send', '--task', '--assign', 'alice', '-m', 'Job']))
    const full = find(w.json(['log']), m => m.id.startsWith(task)).id
    const genesis = w.json(['sessions'])[0].genesis
    assert.equal(w.run(['signals']).err, '')
    // A forged signal: alice claims a completion her message never made.
    const env = {...process.env, GIT_COMMITTER_NAME: 'alice', GIT_COMMITTER_EMAIL: 'alice@ringi'}
    spawnSync('git', ['--git-dir', path.join(w.home, 'hub', 'local', 'store', '.git'), 'tag', '-a', '-m', 'forged', `ringi/${genesis}/alice/${full}.state.completed`, full], {env})
    assert.match(w.run(['signals']).err, /ALARM signal .*alice.*points at a message of operator/)
    w.git('tag', '-d', `ringi/${genesis}/alice/${full}.state.completed`)
    // An accepted signal replaced by another object, then removed.
    const ref = `ringi/${genesis}/operator/${full}.opened`
    w.git('tag', '-f', '-a', '-m', 'replaced', ref, full)
    assert.match(w.run(['signals']).err, /ALARM signal refs\/tags\/.*\.opened was replaced after it was accepted/)
    w.git('tag', '-d', ref)
    assert.match(w.run(['signals']).err, /was removed after it was accepted/)
  })

  it('tags only the usage receipts a grant\'s ledger counts', (t) => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    for (const [as, who] of [['C', 'codex'], ['L', 'claude']]) w.ok(['join', 'local', 'r', '--as', who], {as})
    const note = w.id(w.ok(['agent', 'send', '--to', 'operator', '-m', 'just a note'], {as: 'C'}))
    w.ok(['agent', 'send', '--to', 'operator', '-m', 'here too'], {as: 'L'})
    const p = w.id(w.ok(['propose', '-m', 'runs', '--decider', 'operator', '--budget', 'runs=5']))
    w.ok(['decide', p, 'approved', '-m', 'go'])
    const [grant] = w.json(['grants'])
    const full = (short: string) => find(w.json(['log', '--all']), m => m.id.startsWith(short)).id
    // Receipts written past ringi: one naming a note, a run settled twice, a settlement before its reservation, and
    // claude's run under the same Run id as codex's.
    const env = (who: string) => ({...process.env, GIT_AUTHOR_NAME: who, GIT_AUTHOR_EMAIL: `${who}@ringi`, GIT_COMMITTER_NAME: who, GIT_COMMITTER_EMAIL: `${who}@ringi`})
    const store = path.join(w.home, 'hub', 'local', 'store', '.git')
    const receipt = (subject: string, trailers: string, who = 'codex') => {
      const ref = `refs/heads/r/log/${who}`
      const head = w.git('rev-parse', ref)
      const sha = spawnSync('git', ['--git-dir', store, 'commit-tree', w.git('rev-parse', `${head}^{tree}`), '-p', head, '-m', `${subject}\n\nTo: operator\nKind: usage\n${trailers}`],
        {encoding: 'utf8', env: env(who)}).stdout.trim()
      w.git('update-ref', ref, sha, head)
      return sha
    }
    const stray = receipt('usage: reserve', `Grant: ${full(note)}\nUsage: reserve\nRun: r0`)
    receipt('usage: reserve', `Grant: ${grant.grant}\nUsage: reserve\nRun: r1`)
    const first = receipt('usage: settle', `Grant: ${grant.grant}\nUsage: settle\nRun: r1\nSeconds: 5\nExit: 0`)
    const again = receipt('usage: settle', `Grant: ${grant.grant}\nUsage: settle\nRun: r1\nSeconds: 7\nExit: 0`)
    const early = receipt('usage: settle', `Grant: ${grant.grant}\nUsage: settle\nRun: r2\nSeconds: 11\nExit: 0`)
    receipt('usage: reserve', `Grant: ${grant.grant}\nUsage: reserve\nRun: r2`)
    receipt('usage: reserve', `Grant: ${grant.grant}\nUsage: reserve\nRun: r1`, 'claude')
    receipt('usage: settle', `Grant: ${grant.grant}\nUsage: settle\nRun: r1\nSeconds: 3\nExit: 0`, 'claude')
    assert.match(w.ok(['agent', 'signals', '--repair'], {as: 'C'}), /restored 3 signal\(s\) of codex/)
    assert.match(w.ok(['agent', 'signals', '--repair'], {as: 'L'}), /restored 2 signal\(s\) of claude/)
    const usage = w.json(['signals', '--all']).filter(s => s.signal.startsWith('usage.'))
    assert.deepEqual(usage.map(s => `${s.actor}:${s.signal}`).sort(),
      ['claude:usage.reserve', 'claude:usage.settle', 'codex:usage.reserve', 'codex:usage.reserve', 'codex:usage.settle'])
    assert.equal(find(usage, s => s.actor === 'codex' && s.signal === 'usage.settle').target, first)
    assert.ok(!usage.some(s => [stray, again, early].includes(s.target)))
    // Three runs, codex's r2 still open; 5s and 3s spent, the duplicate and the early settlement count nothing.
    assert.match(w.ok(['grants']), /runs 3\/5, open 1, 8s used/)
    // A tag forged on the receipt no grant counts is an alarm.
    const genesis = w.json(['sessions'])[0].genesis
    const body = `usage.reserve\n\nRoom: r\nGenesis: ${genesis}\nActor: codex\nMessage: ${stray}\nSignal: usage.reserve\n`
    spawnSync('git', ['--git-dir', store, 'tag', '-a', '-F', '-', `ringi/${genesis}/codex/${stray}.usage.reserve`, stray], {env: env('codex'), input: body})
    assert.match(w.run(['signals', '--all']).err, /ALARM signal .*codex.*did not make usage\.reserve/)
  })

  it('reports two disagreeing old pins of one signal on every read', (t) => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    w.ok(['send', '--task', '--assign', 'alice', '-m', 'Job'])
    w.ok(['signals'])
    // A reader state from before pins were keyed by name: the live ref and an archive ref of one signal disagree.
    const dir = path.join(w.home, 'readers', 'local')
    const genesis = fs.readdirSync(dir)[0]
    const file = path.join(dir, genesis, 'operator.json')
    const st = JSON.parse(fs.readFileSync(file, 'utf8'))
    const [key, object] = Object.entries(st.signals as Record<string, string>).find(([k]) => k.endsWith('.opened'))!
    const name = key.split('/').slice(-2).join('/')
    // The live pin holds what was accepted first; the archive pin holds what is there now. Without care the second
    // would quietly win after one read.
    st.signals = {[`refs/tags/ringi/${genesis}/${name}`]: '0'.repeat(40), [`refs/archive/r@${genesis.slice(0, 8)}/signals/${name}`]: object}
    fs.writeFileSync(file, JSON.stringify(st))
    for (let i = 0; i < 2; i++) assert.match(w.run(['signals']).err, /ALARM signal .*\.opened has two different accepted objects/)
  })

  it('keeps a reader\'s pins when the room is archived', (t) => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    w.ok(['join', 'local', 'r', '--as', 'alice'], {as: 'A'})
    const task = w.id(w.ok(['send', '--task', '--assign', 'alice', '-m', 'Job']))
    w.ok(['agent', 'inbox'], {as: 'A'})
    w.ok(['agent', 'reply', task, '--state', 'completed', '-m', 'done'], {as: 'A'})
    assert.equal(w.run(['signals']).err, '')
    const archived = /archived r as (r@\w+)/.exec(w.ok(['room', 'archive', 'r']))![1]
    // The signals moved with the room; the operator's pins still name them.
    const read = w.run(['log', '--room', archived])
    assert.equal(read.code, 0, read.err)
    assert.doesNotMatch(read.err, /ALARM/)
    assert.deepEqual(w.json(['signals', '--room', archived]).map(s => `${s.actor}:${s.signal}`).sort(),
      ['alice:read', 'alice:state.completed', 'operator:assigned', 'operator:opened'])
  })

  it('restores the missing signals of one\'s own messages', (t) => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    w.ok(['send', '--task', '--assign', 'alice', '-m', 'Job'])
    const genesis = w.git('rev-list', '--reverse', 'refs/heads/r/control', '^refs/heads/main').split('\n')[0]
    for (const tag of w.git('tag', '-l', `ringi/${genesis}/*`).split('\n').filter(Boolean)) w.git('tag', '-d', tag)
    assert.match(w.ok(['signals']), /no signals/)
    assert.match(w.ok(['signals', '--repair']), /restored 2 signal\(s\) of operator/)
    assert.deepEqual(w.json(['signals']).map(s => s.signal).sort(), ['assigned', 'opened'])
  })
})

describe('marks: the second layer, where attention is', () => {
  it('leaves a read mark on delivery and a taken mark on demand, and shows them; neither changes the work', (t) => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    for (const [as, who] of [['A', 'alice'], ['B', 'bob']]) w.ok(['join', 'local', 'r', '--as', who], {as})
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
    for (const [as, who] of [['A', 'alice'], ['B', 'bob']]) w.ok(['join', 'local', 'r', '--as', who], {as})
    const note = w.id(w.ok(['send', '--to', 'alice', '-m', 'just a note']))
    w.no(['agent', 'take', note], /does not open work/, {as: 'A'})
    const full = find(w.json(['log']), m => m.id.startsWith(note)).id
    const genesis = w.json(['sessions'])[0].genesis
    // bob marks as read a message addressed to alice only.
    const env = {...process.env, GIT_COMMITTER_NAME: 'bob', GIT_COMMITTER_EMAIL: 'bob@ringi'}
    const body = `read\n\nRoom: r\nGenesis: ${genesis}\nActor: bob\nMessage: ${full}\nSignal: read\n`
    spawnSync('git', ['--git-dir', path.join(w.home, 'hub', 'local', 'store', '.git'), 'tag', '-a', '-F', '-', `ringi/${genesis}/bob/${full}.read`, full], {env, input: body})
    assert.match(w.run(['signals']).err, /ALARM signal .*bob.*not delivered to bob/)
  })
})

describe('hubs: a descriptor beside a store', () => {
  it('ends quietly when its reader closes the pipe early', () => {
    // `true` exits without reading, so every write of ringi meets a closed pipe.
    // Both ways in: the executable, and a program that imports main (the launcher in the package root does).
    const viaMain = `--input-type=module -e "const {main} = await import('${pathToFileURL(CLI).href}'); await main(['help'])"`
    for (const run of [`'${CLI}' help`, viaMain]) {
      const r = spawnSync('sh', ['-c', `'${process.execPath}' ${run} | true`], {encoding: 'utf8', env: BASE})
      assert.equal(r.status, 0)
      assert.doesNotMatch(r.stderr, /EPIPE|Unhandled/, run)
    }
  })

  it('enforces one major of each capability a contract selects', (t) => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    w.ok(['hub', 'amend', '-m', 'two majors', '--set', 'capabilities=decisions/1,decisions/2,profiles/1'])
    w.no(['where'], /selects two majors of decisions, which this ringi .* cannot enforce/)
  })

  it('refuses a room\'s history offered under another name', (t) => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    w.ok(['send', '--to', '*', '-m', 'only in r'])
    // A store that copies r's control and logs to `other`, and invents an archive of r.
    for (const ref of w.git('for-each-ref', '--format=%(refname)', 'refs/heads/r/').split('\n')) w.git('update-ref', ref.replace('/r/', '/other/'), w.git('rev-parse', ref))
    w.git('update-ref', 'refs/archive/r@00000000/control', w.git('rev-parse', 'refs/heads/r/control'))
    const list = w.run(['room', 'list', '--archived'])
    assert.equal(list.code, 0, list.err)
    assert.match(list.out, /^\* r +1 member/m)
    assert.doesNotMatch(list.out, /other/)
    assert.match(list.err, /ALARM room other: its genesis is "room r"/)
    assert.doesNotMatch(list.out, /r@00000000/)
    assert.match(list.err, /ALARM room r@00000000: its genesis is "room r"/)
    w.no(['log', '--room', 'other'], /its genesis is "room r"; refusing a room's history under another name/)
    w.no(['log', '--room', 'r@00000000'], /its genesis is "room r"/)
    // The real archive still reads.
    const archived = /archived r as (r@\w+)/.exec(w.ok(['room', 'archive', 'r']))![1]
    assert.match(w.ok(['log', '--room', archived]), /only in r/)
  })

  it('keeps what this machine knows in hub.json and the shared contract in the store', (t) => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    const d = JSON.parse(fs.readFileSync(path.join(w.home, 'hub', 'local', 'hub.json'), 'utf8'))
    assert.deepEqual(d, {schema: 'ringi-hub/2', name: 'local', trust: 'asserted', store: {type: 'git', path: 'store'}})
    assert.deepEqual(w.git('ls-tree', '-r', '--name-only', 'main').split('\n'), ['HUB.md', 'authority.json', 'contract.json', 'profiles/a2a-1.json'])
    assert.match(w.git('show', 'main:contract.json'), /"profile": "a2a-1"/)
  })

  it('refuses a planned store type it does not implement yet, and one it does not know', (t) => {
    const w = world(t)
    w.ok(['hub'])
    const f = path.join(w.home, 'hub', 'local', 'hub.json')
    const d = JSON.parse(fs.readFileSync(f, 'utf8'))
    for (const type of ['kafka', 'temporal']) {
      fs.writeFileSync(f, JSON.stringify({...d, store: {type, path: 'store'}}))
      w.no(['where'], new RegExp(`the ${type} store is planned and not implemented`))
    }
    fs.writeFileSync(f, JSON.stringify({...d, store: {type: 'teleport', path: 'store'}}))
    w.no(['where'], /hub local uses a teleport store; this ringi .* knows git, kafka, temporal/)
  })

  it('moves a home of the previous layout into descriptor and store, room and sessions intact', (t) => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    w.ok(['join', 'local', 'r', '--as', 'alice'], {as: 'A'})
    w.ok(['send', '--to', 'alice', '-m', 'before the move'])
    // Back to the old layout: hub/local.git with no descriptor, home version 2.
    fs.renameSync(path.join(w.home, 'hub', 'local', 'store', '.git'), path.join(w.home, 'hub', 'local.git'))
    fs.rmSync(path.join(w.home, 'hub', 'local'), {recursive: true})
    fs.writeFileSync(path.join(w.home, 'home.json'), '{"version":2}')
    const r = w.run(['agent', 'inbox'], {as: 'A'})
    assert.equal(r.code, 0, r.err)
    assert.match(r.err, /moved hub local to .*hub\/local \(descriptor hub\.json, store\/\.git\)/)
    assert.match(r.out, /before the move/)
    assert.equal(JSON.parse(fs.readFileSync(path.join(w.home, 'home.json'), 'utf8')).version, 3)
  })
})
