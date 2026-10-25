// Gitea's real API readback and SSH enforcement. This opt-in suite provisions only disposable fixture accounts and
// keys through server.ts. Its final raw Git probes are terminal: no ringi reader consumes their fixture commits.
import {describe, it} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {BASE, BIN, FIXTURE_GIT} from '../ts/cli.ts'
import {ORG, dockerAvailable, server} from './server.ts'
import type {Server} from './server.ts'

type Result = {code: number | null, out: string, err: string}
const ring = (home: string, session?: string) => (...args: string[]): Result => {
  const r = spawnSync(BIN[0], [...BIN.slice(1), ...args], {encoding: 'utf8', timeout: 300_000,
    env: {...BASE, RINGI_HOME: home, ...(session ? {RINGI_SESSION: session} : {})}})
  return {code: r.status, out: r.stdout, err: r.stderr}
}
type Ring = ReturnType<typeof ring>
const ok = (r: Result, what: string) => { assert.equal(r.code, 0, `${what}: ${r.err}`); return r.out }
const git = (store: string, ...args: string[]) => {
  const r = spawnSync('git', ['--git-dir', store, ...args], {encoding: 'utf8', timeout: 30_000, env: FIXTURE_GIT})
  assert.equal(r.status, 0, `fixture git ${args[0]}: ${r.stderr}`)
  return r.stdout.trim()
}
const keyOf = (home: string, actor: string) => {
  const dir = path.join(home, 'keys')
  const found = fs.readdirSync(dir, {recursive: true}).map(String).filter(f => f.endsWith(`/${actor}`))
  assert.equal(found.length, 1, `one fixture key for ${actor}`)
  return path.join(dir, found[0])
}
const storeOf = (home: string) => {
  const dir = path.join(home, 'clones'), clones = fs.readdirSync(dir)
  assert.equal(clones.length, 1, 'one fixture room clone')
  return path.join(dir, clones[0], 'store', '.git')
}
const invitationOf = (out: string, actor: string) => {
  const line = out.split('\n').findIndex(x => x.startsWith(`alice joins as ${actor}:`) || x.startsWith(`bob joins as ${actor}:`))
  assert.notEqual(line, -1, `invitation for ${actor}: ${out}`)
  const invitation = /ringi join (ringi:\S+)/.exec(out.split('\n')[line + 1])
  assert.ok(invitation, `join command for ${actor}`)
  return invitation[1]
}
const enrol = async (s: Server, op: Ring, agent: Ring, invitation: string, login: string, actor: string) => {
  const pending = agent('join', invitation)
  assert.equal(pending.code, 3, pending.err)
  const match = /ringi room admit ([a-z0-9-]+) '([^']+)'/.exec(pending.out)
  assert.ok(match, pending.out)
  assert.equal(match[1], actor)
  const refused = op('room', 'admit', actor, match[2])
  assert.notEqual(refused.code, 0)
  assert.match(refused.err, new RegExp(`not on ${login}'s SSH keys`))
  // Re-inviting the same account enrols a new actor key; Gitea also requires a distinct title for that second key.
  const enrolled = await s.api('POST', `/admin/users/${login}/keys`, {
    title: `${actor}'s fixture machine`, key: match[2].trim().split(/\s+/).slice(0, 2).join(' '),
  })
  assert.equal(enrolled.status, 201, `key on ${login} for ${actor}: ${JSON.stringify(enrolled.body)}`)
  const admitted = op('room', 'admit', actor, match[2])
  if (admitted.code !== 0) {
    const policy = await s.api('GET', `/repos/${ORG}/fix/branch_protections`)
    assert.equal(admitted.code, 0, `admit ${actor}: ${admitted.err}\nserver policy: ${JSON.stringify(policy.body)}`)
  }
  assert.match(ok(agent('join', invitation), `join ${actor}`), new RegExp(`joined gitea://localhost:\\d+/team/fix as ${actor}`))
  return match[2]
}
const work = (op: Ring, agent: Ring, actor: string) => {
  ok(op('send', '--task', '--assign', actor, '-m', `Fixture work for ${actor}`), 'send signed task')
  const messages = JSON.parse(ok(agent('agent', 'inbox', '--json'), 'inbox')) as Array<{id: string, kind: string, trust: string}>
  const task = messages.find(m => m.kind === 'task')
  assert.ok(task)
  assert.equal(task.trust, 'verified')
  ok(agent('agent', 'reply', task.id, '--state', 'completed', '-m', 'Fixture result'), 'signed reply')
  const tasks = JSON.parse(ok(op('tasks', '--all', '--json'), 'tasks')) as Array<{id: string, state: string, by: string}>
  assert.ok(tasks.some(t => t.id === task.id && t.state === 'completed' && t.by === actor))
}
type Rule = {rule_name: string, priority: number, enable_push: boolean, enable_push_whitelist: boolean,
  push_whitelist_usernames: string[] | null, push_whitelist_teams: string[] | null,
  push_whitelist_deploy_keys: boolean, enable_force_push: boolean, unprotected_file_patterns: string}
const matrix = async (s: Server, actors: Record<string, string>) => {
  const response = await s.api<Rule[]>('GET', `/repos/${ORG}/fix/branch_protections`)
  assert.equal(response.status, 200)
  const rows = response.body, fallback = rows.find(r => r.rule_name === '**')
  assert.ok(fallback)
  assert.equal(fallback.enable_push, false)
  assert.deepEqual(fallback.push_whitelist_usernames ?? [], [])
  const expected = {main: ['root'], chat: [...new Set(['root', ...Object.values(actors)])],
    'operator/signals': ['root'], ...Object.fromEntries(Object.entries(actors).map(([actor, account]) => [`${actor}/signals`, [account]]))}
  assert.equal(rows.length, Object.keys(expected).length + 1)
  for (const [name, accounts] of Object.entries(expected)) {
    const row = rows.find(r => r.rule_name === name)
    assert.ok(row, `${name} rule exists`)
    assert.equal(row.enable_push, true, name)
    assert.equal(row.enable_push_whitelist, true, name)
    assert.deepEqual([...(row.push_whitelist_usernames ?? [])].sort(), [...accounts].sort(), name)
    assert.ok(Number.isSafeInteger(row.priority) && row.priority > 0 && row.priority < fallback.priority,
      `${name} precedes the deny fallback, including actors admitted later`)
  }
  for (const row of rows) {
    assert.equal(row.enable_force_push, false)
    assert.equal(row.push_whitelist_deploy_keys, false)
    assert.deepEqual(row.push_whitelist_teams ?? [], [])
    assert.equal(row.unprotected_file_patterns, '')
  }
  const tags = await s.api<Array<{name_pattern: string, whitelist_usernames: string[], whitelist_teams: string[] | null}>>('GET', `/repos/${ORG}/fix/tag_protections`)
  assert.equal(tags.status, 200)
  assert.equal(tags.body.length, 1)
  assert.equal(tags.body[0].name_pattern, '*')
  assert.deepEqual(tags.body[0].whitelist_usernames, ['root'])
  assert.deepEqual(tags.body[0].whitelist_teams ?? [], [])
}
const after = (store: string, parent: string) => git(store, 'commit-tree', git(store, 'rev-parse', `${parent}^{tree}`), '-p', parent, '-m', 'Terminal fixture permission probe')

describe('a room on Gitea in docker', {skip: !dockerAvailable() && 'docker is not available'}, () => {
  it('round-trips signed work, orders later actors before deny, and enforces account permissions over SSH', async t => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ringi-it-gitea-')))
    t.after(() => fs.rmSync(base, {recursive: true, force: true}))
    const s = await server(t, 'gitea', base), room = `${s.space}/fix`
    const version = await s.api<{version: string}>('GET', '/version')
    assert.equal(version.status, 200)
    assert.match(version.body.version, /^1\.(25|26|27)\.\d+(?:[+-].*)?$/)
    s.user('alice'); s.user('bob')
    const op = ring(path.join(base, 'op')), firstHome = path.join(base, 'alice'), first = ring(firstHome, 'A')
    const created = ok(op('room', 'create', room, '--invite', 'alice', '--token-file', s.tokenFile, '--host-key-file', s.hostKeyFile), 'create Gitea room')
    const repo = await s.api<{private: boolean}>('GET', `/repos/${ORG}/fix`)
    assert.equal(repo.status, 200)
    assert.equal(repo.body.private, true)
    const firstKey = await enrol(s, op, first, invitationOf(created, 'alice'), 'alice', 'alice')
    work(op, first, 'alice')
    await matrix(s, {alice: 'alice'})

    const bob = ring(path.join(base, 'bob'), 'B')
    await enrol(s, op, bob, invitationOf(ok(op('room', 'invite', 'bob'), 'invite later account'), 'bob'), 'bob', 'bob')
    work(op, bob, 'bob')
    await matrix(s, {alice: 'alice', bob: 'bob'})

    const oldStore = storeOf(firstHome), oldKey = keyOf(firstHome, 'alice')
    const oldTip = git(oldStore, 'rev-parse', 'refs/heads/alice/signals')
    ok(op('room', 'remove', 'alice'), 'remove alice')
    assert.equal((await s.api('GET', `/repos/${ORG}/fix/collaborators/alice`)).status, 404)
    await matrix(s, {bob: 'bob'})
    assert.notEqual(s.push(oldStore, oldKey, 'fix', `${oldTip}:refs/heads/alice/signals`).status, 0, 'removed account cannot push')

    const againHome = path.join(base, 'alice-again'), again = ring(againHome, 'A2')
    const invitation = invitationOf(ok(op('room', 'invite', 'alice'), 're-invite account'), 'alice-2')
    const nextKey = await enrol(s, op, again, invitation, 'alice', 'alice-2')
    assert.notEqual(nextKey.split(/\s+/)[1], firstKey.split(/\s+/)[1], 'new actor uses a new key')
    work(op, again, 'alice-2')
    await matrix(s, {'alice-2': 'alice', bob: 'bob'})

    // New commits avoid an up-to-date positive control and non-fast-forward false positives. These raw objects are
    // confined to the disposable fixture and are never subsequently read as ringi journal or signal entries.
    const store = storeOf(againHome), key = keyOf(againHome, 'alice-2')
    const ownRef = 'refs/heads/alice-2/signals', own = after(store, git(store, 'rev-parse', ownRef))
    const pushed = s.push(store, key, 'fix', `${own}:${ownRef}`)
    assert.equal(pushed.status, 0, pushed.err)
    const branches = await s.api<Array<{name: string, commit: {id: string}}>>('GET', `/repos/${ORG}/fix/branches?limit=50`)
    assert.equal(branches.status, 200)
    assert.equal(branches.body.find(b => b.name === 'alice-2/signals')?.commit.id, own, 'server accepted a new own-branch commit')
    for (const ref of ['main', 'operator/signals', 'bob/signals']) {
      const parent = git(store, 'rev-parse', `refs/heads/${ref}`)
      assert.equal(parent, branches.body.find(b => b.name === ref)?.commit.id, `${ref} probe would fast-forward the server's current tip`)
      const commit = after(store, parent)
      const refused = s.push(store, key, 'fix', `${commit}:refs/heads/${ref}`)
      assert.notEqual(refused.status, 0, `alice wrote ${ref}`)
      assert.match(refused.err, /\[remote rejected\]|remote:.*(?:protected|not allowed)/i, refused.err)
    }
    const chatParent = git(store, 'rev-parse', 'refs/heads/chat^')
    for (const refspec of [`${own}:refs/heads/unlisted/signals`, `+${chatParent}:refs/heads/chat`, `${own}:refs/tags/v1`]) {
      const refused = s.push(store, key, 'fix', refspec)
      assert.notEqual(refused.status, 0, `alice wrote ${refspec}`)
      assert.match(refused.err, /\[remote rejected\]|remote:.*(?:protected|not allowed)/i, refused.err)
    }
  })
})
