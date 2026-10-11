// A room made with the old layout must keep its messages and joined chats when it becomes one branch.
import {describe, it} from 'node:test'
import type {TestContext} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {BASE, BIN, FIXTURE_GIT} from './cli.ts'

const legacy = (t: TestContext) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ringi-migration-'))
  t.after(() => fs.rmSync(home, {recursive: true, force: true}))
  const run = (args: string[], as?: string) => spawnSync(BIN[0], [...BIN.slice(1), ...args], {
    encoding: 'utf8', env: {...BASE, RINGI_HOME: home, ...(as ? {RINGI_SESSION: as} : {})},
  })
  const ok = (args: string[], as?: string) => { const r = run(args, as); assert.equal(r.status, 0, r.stderr); return r.stdout }
  ok(['room', 'create', 'r'])
  ok(['join', 'local', 'r', '--as', 'codex'], 'codex-chat')
  ok(['join', 'local', 'r', '--as', 'claude'], 'claude-chat')
  const dir = path.join(home, 'hub', 'local', 'store', '.git')
  const git = (args: string[], input?: string, who = 'operator') => {
    const r = spawnSync('git', ['--git-dir', dir, ...args], {encoding: 'utf8', input,
      env: {...FIXTURE_GIT, GIT_AUTHOR_NAME: who, GIT_AUTHOR_EMAIL: `${who}@fixture`, GIT_COMMITTER_NAME: who, GIT_COMMITTER_EMAIL: `${who}@fixture`}})
    assert.equal(r.status, 0, r.stderr)
    return r.stdout.trim()
  }
  const ctl = git(['rev-parse', 'refs/heads/r'])
  const genesis = git(['rev-list', '--reverse', ctl, '^refs/heads/main']).split('\n')[0]
  const blob = git(['hash-object', '-w', '--stdin'], 'original attachment\n')
  const tree = git(['mktree'], `100644 blob ${blob}\tresult.txt\n`)
  const task = git(['commit-tree', tree, '-p', genesis], 'Review\n\nTo: codex\nKind: task\nAssign: codex\nRingi-Files: ["result.txt"]\n', 'claude')
  const reply = git(['commit-tree', tree, '-p', genesis], `Reading\n\nTo: claude\nRe: ${task}\n`, 'codex')
  git(['update-ref', '-d', 'refs/heads/r', ctl])
  for (const [ref, sha] of [['refs/heads/r/control', ctl], ['refs/heads/r/log/claude', task], ['refs/heads/r/log/codex', reply]]) git(['update-ref', ref, sha])
  const readers = path.join(home, 'readers', 'local', genesis)
  fs.mkdirSync(readers, {recursive: true})
  const state = path.join(readers, 'codex.json')
  const tag = (actor: string, target: string, signal: string, date = '1700000000 +0300') => {
    const name = `ringi/${genesis}/${actor}/${target}.${signal}`, ref = `refs/tags/${name}`
    const header = `object ${target}\ntype commit\ntag ${name}\ntagger ${actor} <${actor}@fixture> ${date}\n\n`
    const body = `${signal}\n\nRoom: r\nGenesis: ${genesis}\nActor: ${actor}\nMessage: ${target}\nSignal: ${signal}\n`
    const object = git(['mktag'], header + body)
    git(['update-ref', ref, object])
    return {ref, object, key: `${actor}.${signal}.${target.slice(0, 12)}`, actor, target, signal, date}
  }
  const tags = [tag('claude', task, 'opened'), tag('codex', task, 'read')]
  const signals = Object.fromEntries(tags.map(s => [`${s.actor}/${s.target}.${s.signal}`, s.object]))
  fs.writeFileSync(state, JSON.stringify({control: ctl, heads: {claude: task, codex: reply}, seen: {claude: task}, pending: [task], signals}))
  for (const [who, sha] of [['claude', task], ['codex', reply]]) git(['update-ref', `refs/ringi/accepted/${genesis}/codex/${who}`, sha])
  return {home, dir, run, ok, git, ctl, genesis, task, reply, state, tag, tags}
}

describe('legacy room migration', () => {
  it('keeps ids, files, accepted heads and both chat bindings while new replies share one branch', t => {
    const w = legacy(t)
    assert.match(w.run(['agent', 'whoami'], 'codex-chat').stderr, /room migrate r/)
    assert.match(w.ok(['room', 'migrate', 'r']), /uses one branch/)
    assert.deepEqual(w.git(['for-each-ref', '--format=%(refname)', 'refs/heads/']).split('\n'), ['refs/heads/main', 'refs/heads/r'])
    assert.match(w.ok(['agent', 'whoami'], 'codex-chat'), new RegExp(`codex in local/r .*genesis ${w.genesis.slice(0, 12)}`))
    assert.match(w.ok(['agent', 'whoami'], 'claude-chat'), /claude in local\/r/)
    assert.equal(w.ok(['agent', 'cat', w.task, 'result.txt'], 'codex-chat'), 'original attachment\n')
    assert.match(w.ok(['agent', 'read', w.reply], 'codex-chat'), /Reading/)
    const before = JSON.parse(fs.readFileSync(w.state, 'utf8'))
    assert.equal(before.heads.claude, w.task)
    assert.equal(before.heads.codex, w.reply)
    assert.deepEqual(before.seen, {claude: w.task})
    assert.deepEqual(before.pending, [w.task])
    for (const s of w.tags) {
      const object = w.git(['rev-parse', `refs/tags/${s.key}`])
      const header = `object ${s.target}\ntype commit\ntag ${s.key}\ntagger ${s.actor} <${s.actor}@fixture> ${s.date}\n\n`
      assert.equal(w.git(['cat-file', '-s', object]), String(Buffer.byteLength(header)), 'the new tag has an empty body')
      assert.equal(w.git(['cat-file', 'tag', object]), header.trim())
      assert.equal(before.signals[s.key], object)
      assert.equal(w.git(['rev-parse', s.ref.replace(`refs/tags/ringi/${w.genesis}/`, `refs/ringi/legacy/${w.genesis}/signals/`)]), s.object)
    }
    assert.equal(w.git(['for-each-ref', '--format=%(refname)', 'refs/tags/ringi/']), '')
    const snapshots = path.join(w.home, 'migration', 'local', w.genesis, 'readers')
    const saved = JSON.parse(fs.readFileSync(path.join(snapshots, fs.readdirSync(snapshots)[0]), 'utf8'))
    assert.deepEqual(saved.signals, Object.fromEntries(w.tags.map(s => [`${s.actor}/${s.target}.${s.signal}`, s.object])))
    const sent = /sent (\w+)/.exec(w.ok(['agent', 'reply', w.task, '--state', 'completed', '-m', 'Done'], 'codex-chat'))![1]
    const received = w.ok(['agent', 'inbox'], 'claude-chat')
    assert.match(received, /codex \(asserted\) → claude[\s\S]*Subject: Done/)
    assert.doesNotMatch(received, /ALARM/)
    w.ok(['agent', 'reply', sent, '-m', 'Accepted'], 'claude-chat')
    assert.match(w.ok(['agent', 'inbox'], 'codex-chat'), /Subject: Accepted/)
    const tip = w.git(['rev-parse', 'refs/heads/r'])
    for (const sha of [w.ctl, w.task, w.reply]) assert.equal(w.git(['merge-base', sha, tip]), sha)
    assert.equal(w.git(['show', '-s', '--format=%P', tip]).split(' ').length, 1)
    assert.equal(w.git(['show', '-s', '--format=%P', `${tip}^`]).split(' ').length, 1)
    assert.match(w.ok(['room', 'migrate', 'r']), /uses one branch/)
    assert.equal(w.git(['rev-parse', 'refs/heads/r']), tip, 'a repeated migration does not add another record')
  })

  it('remains readable and resumes after the legacy refs moved but the final branch was not created', t => {
    const w = legacy(t)
    w.ok(['room', 'migrate', 'r'])
    const tip = w.git(['rev-parse', 'refs/heads/r'])
    w.git(['update-ref', 'refs/ringi/migrating/r', tip])
    w.git(['update-ref', '-d', 'refs/heads/r', tip])
    assert.match(w.ok(['agent', 'whoami'], 'codex-chat'), /codex in local\/r/)
    assert.match(w.ok(['agent', 'read', w.task], 'codex-chat'), /Review/)
    w.ok(['room', 'migrate', 'r'])
    assert.equal(w.git(['rev-parse', 'refs/heads/r']), tip)
    assert.equal(w.git(['for-each-ref', '--format=%(refname)', 'refs/ringi/migrating/']), '')
  })

  it('refuses to migrate an already rewritten accepted log and leaves the old refs intact', t => {
    const w = legacy(t)
    const tr = w.git(['rev-parse', `${w.task}^{tree}`])
    const changed = w.git(['commit-tree', tr, '-p', w.genesis], 'Replacement\n\nTo: codex\n', 'claude')
    w.git(['update-ref', 'refs/heads/r/log/claude', changed, w.task])
    const r = w.run(['room', 'migrate', 'r'])
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /ALARM.*lost accepted history/)
    assert.equal(w.git(['rev-parse', 'refs/heads/r/control']), w.ctl)
    assert.equal(w.git(['rev-parse', 'refs/heads/r/log/claude']), changed)
    assert.equal(w.git(['for-each-ref', '--format=%(refname)', 'refs/ringi/migrating/', 'refs/ringi/legacy/']), '')
  })

  it('resumes tag pins after a crash following the ref transaction, including on an already shared room', t => {
    const w = legacy(t), original = fs.readFileSync(w.state, 'utf8')
    w.ok(['room', 'migrate', 'r'])
    const tip = w.git(['rev-parse', 'refs/heads/r'])
    fs.writeFileSync(w.state, original)
    // A new reader version may already have shortened the old keys while still pinning the old objects.
    const st = JSON.parse(original)
    st.signals = Object.fromEntries(w.tags.map(s => [s.key, s.object]))
    const other = path.join(path.dirname(w.state), 'operator.json')
    fs.writeFileSync(other, JSON.stringify(st))
    const lostActor = path.join(path.dirname(w.state), 'claude.json')
    st.signals = Object.fromEntries(w.tags.map(s => [`${s.target}.${s.signal}`, s.object]))
    fs.writeFileSync(lostActor, JSON.stringify(st))
    w.ok(['room', 'migrate', 'r'])
    assert.equal(w.git(['rev-parse', 'refs/heads/r']), tip)
    for (const file of [w.state, other, lostActor]) {
      const restored = JSON.parse(fs.readFileSync(file, 'utf8'))
      for (const s of w.tags) assert.equal(restored.signals[s.key], w.git(['rev-parse', `refs/tags/${s.key}`]))
      assert.deepEqual(restored.pending, [w.task])
    }
    const good = fs.readFileSync(w.state, 'utf8')
    w.git(['update-ref', '-d', `refs/tags/${w.tags[0].key}`])
    const failed = w.run(['room', 'migrate', 'r'])
    assert.notEqual(failed.status, 0)
    assert.match(failed.stderr, /ALARM migrated signal.*removed/)
    assert.equal(fs.readFileSync(w.state, 'utf8'), good, 'a removed migrated tag is never silently restored')
  })

  it('refuses deleted or replaced accepted tags before moving any old room refs', t => {
    for (const how of ['deleted', 'replaced', 'shortened-deleted', 'lost-identity']) {
      const w = legacy(t), s = w.tags[0]
      if (how === 'replaced') w.tag(s.actor, s.target, s.signal, '1700000001 +0300')
      else if (how !== 'lost-identity') w.git(['update-ref', '-d', s.ref])
      if (how === 'shortened-deleted') {
        const st = JSON.parse(fs.readFileSync(w.state, 'utf8'))
        st.signals = Object.fromEntries(w.tags.map(s => [s.key, s.object]))
        fs.writeFileSync(w.state, JSON.stringify(st))
      }
      if (how === 'lost-identity') {
        const st = JSON.parse(fs.readFileSync(w.state, 'utf8'))
        st.signals = {[`${w.reply}.${s.signal}`]: s.object}
        fs.writeFileSync(w.state, JSON.stringify(st))
      }
      const before = fs.readFileSync(w.state, 'utf8'), r = w.run(['room', 'migrate', 'r'])
      assert.notEqual(r.status, 0, how)
      assert.match(r.stderr, /ALARM accepted signal.*(?:missing|replaced|lost its verified identity)/)
      assert.equal(fs.readFileSync(w.state, 'utf8'), before)
      assert.equal(w.git(['rev-parse', 'refs/heads/r/control']), w.ctl)
      assert.equal(w.git(['for-each-ref', '--format=%(refname)', 'refs/ringi/migrating/', 'refs/ringi/legacy/']), '')
    }
  })

  it('refuses a conflicting shortened tag without replacing it or changing reader pins', t => {
    const w = legacy(t), s = w.tags[0], before = fs.readFileSync(w.state, 'utf8')
    const object = w.git(['mktag'], `object ${s.target}\ntype commit\ntag ${s.key}\ntagger ${s.actor} <${s.actor}@fixture> 1700000001 +0300\n\n`)
    w.git(['update-ref', `refs/tags/${s.key}`, object])
    const r = w.run(['room', 'migrate', 'r'])
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /ALARM signal.*collides/)
    assert.equal(w.git(['rev-parse', `refs/tags/${s.key}`]), object)
    assert.equal(fs.readFileSync(w.state, 'utf8'), before)
    assert.equal(w.git(['rev-parse', 'refs/heads/r/control']), w.ctl)
  })
})
