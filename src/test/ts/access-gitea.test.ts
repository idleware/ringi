// Own process-local Gitea API model: numeric first-match priority, server-capped pagination and failed readbacks.
// This checks the adapter's mapping, not a live Gitea server or the CLI composition.
import {describe, it} from 'node:test'
import type {TestContext} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {giteaAccess} from '../../main/ts/adapters/access-gitea/index.ts'
import type {Rule} from '../../main/ts/adapters/access-gitea/rules.ts'
import {fixtureAccess} from './access-fixture.ts'
import {identityCases} from './access-identity-cases.ts'

type Tag = {name_pattern: string, whitelist_usernames: string[], whitelist_teams: string[]}
type Repo = {id: number, private: boolean, chat?: boolean, rules: Rule[], tags: Tag[], collaborators: Map<string, string>}
const fake = (t: TestContext) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ringi-gitea-'))
  const auth = path.join(base, 'dummy-token')
  fs.writeFileSync(auth, 'fixture-only-not-a-real-token', {mode: 0o600})
  const repos = new Map<string, Repo>(), calls: string[] = [], writes: string[] = []
  let nextRepo = 1
  const users = new Map([['root', {id: 1, keys: [] as string[]}], ['alice', {id: 2, keys: [] as string[]}], ['bob', {id: 3, keys: [] as string[]}]])
  const mode = {version: '1.25.0', fail: '', status: 503, total: '', permission: '',
    readbackPushers: '', ignorePriority: false, badKeys: false, hostileLink: false, keepDeleted: false}
  const previous = globalThis.fetch
  t.after(() => { globalThis.fetch = previous; fs.rmSync(base, {recursive: true, force: true}) })
  const response = (value?: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(status === 204 ? null : JSON.stringify(value), {status, headers: {'content-type': 'application/json', ...headers}})
  globalThis.fetch = async (input, init) => {
    const u = new URL(String(input)), p = decodeURIComponent(u.pathname.replace('/api/v1', '')), method = init?.method ?? 'GET'
    assert.equal(u.origin, 'https://gitea.example.invalid', 'the fixture never accepts a request to another origin')
    assert.equal(init?.redirect, 'error')
    assert.equal((init?.headers as Record<string, string>).Authorization, 'token fixture-only-not-a-real-token')
    const call = `${method} ${p}`
    calls.push(call)
    if (method !== 'GET') writes.push(call)
    if (call === mode.fail) { mode.fail = ''; return response({message: 'fixture refusal'}, mode.status, {'retry-after': '17'}) }
    const b = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
    const list = (all: unknown[]) => {
      const page = Number(u.searchParams.get('page') ?? 1), more = all.length > page * 2
      const link = mode.hostileLink ? 'https://gitea.example.invalid.attacker.invalid/steal' : `https://${u.host}${u.pathname}?page=${page + 1}`
      return response(all.slice((page - 1) * 2, page * 2), 200, {...(more ? {link: `<${link}>; rel="next"`, 'x-total-count': String(all.length)} : {}),
        ...(mode.total ? {'x-total-count': mode.total} : {})})
    }
    if (p === '/version') return response({version: mode.version})
    if (p === '/user') return response({login: 'root'})
    if (p === '/user/keys' && method === 'POST') { users.get('root')!.keys.push(String(b.key)); return response({}, 201) }
    if (p === '/user/keys') return list(users.get('root')!.keys.map(key => ({key})))
    const user = /^\/users\/([^/]+)(\/keys)?$/.exec(p)
    if (user) {
      const login = user[1].toLowerCase(), value = users.get(login)
      if (!value) return response({}, 404)
      if (user[2]) return mode.badKeys ? response([{key: 7}]) : list(value.keys.map(key => ({key})))
      return response({login, id: value.id})
    }
    if (p === '/orgs/team/repos' && method === 'POST') {
      const r = {id: nextRepo++, private: b.private === true, rules: [], tags: [], collaborators: new Map([['root', 'admin']])}
      repos.set(String(b.name), r)
      return response({id: r.id, private: r.private, ssh_url: `git@gitea.example.invalid:team/${b.name}.git`}, 201)
    }
    const match = /^\/repos\/team\/([^/]+)(.*)$/.exec(p), r = match && repos.get(match[1]), rest = match?.[2] ?? ''
    if (!r) return response({}, 404)
    if (!rest && method === 'DELETE') { if (!mode.keepDeleted) repos.delete(match![1]); return response(undefined, 204) }
    if (!rest) return response({id: r.id, private: r.private, ssh_url: `git@gitea.example.invalid:team/${match![1]}.git`})
    if (rest === '/branches/chat') return response({}, r.chat ? 200 : 404)
    if (rest === '/branch_protections' && method === 'POST') {
      const rule = {...b, priority: mode.ignorePriority ? Math.max(0, ...r.rules.map(x => x.priority)) + 1 : b.priority} as Rule
      if (!rule.enable_push) rule.enable_push_whitelist = false
      r.rules.push(rule); return response(rule, 201)
    }
    if (rest === '/branch_protections') return response(r.rules.map(row => {
      if (!mode.readbackPushers || row.rule_name !== 'chat') return row
      const names = [...(row.push_whitelist_usernames ?? [])].sort()
      if (mode.readbackPushers === 'missing' && names.length > 1) names.pop()
      if (mode.readbackPushers === 'extra' && names.length > 1) names.push('mallory')
      if (mode.readbackPushers === 'duplicate' && names.length > 1) names.push(names[0])
      return {...row, push_whitelist_usernames: names}
    }))
    const rule = /^\/branch_protections\/(.+)$/.exec(rest)
    if (rule) {
      const had = r.rules.find(x => x.rule_name === rule[1])
      if (method === 'DELETE') { r.rules = r.rules.filter(x => x !== had); return response(undefined, 204) }
      if (!had) return response({}, 404)
      Object.assign(had, b)
      if (!had.enable_push) had.enable_push_whitelist = false
      return response(had)
    }
    if (rest === '/tag_protections' && method === 'POST') { r.tags.push(b as Tag); return response(b, 201) }
    if (rest === '/tag_protections') return response(r.tags)
    const collaborator = /^\/collaborators\/([^/]+)(\/permission)?$/.exec(rest)
    if (collaborator) {
      const who = collaborator[1].toLowerCase()
      if (method === 'PUT') { r.collaborators.set(who, String(b.permission)); return response(undefined, 204) }
      if (method === 'DELETE') { r.collaborators.delete(who); return response(undefined, 204) }
      return response({permission: mode.permission || r.collaborators.get(who) || 'none'})
    }
    throw new Error('unexpected fixture call ' + call)
  }
  const access = fixtureAccess(giteaAccess('gitea://gitea.example.invalid/team', auth))
  const pushers = (room: string, branch: string) => {
    const r = repos.get(room)!, rule = [...r.rules].sort((a, b) => a.priority - b.priority).find(x => x.rule_name === branch || x.rule_name === '**')
    return rule?.enable_push && rule.enable_push_whitelist ? rule.push_whitelist_usernames : []
  }
  return {access, repos, users, calls, writes, mode, auth, pushers}
}

describe('access: gitea', {concurrency: false}, () => {
  identityCases(fake)
  it('accepts Gitea sorted pushers through grant/revoke but refuses missing, extra and duplicated readback members', async t => {
    await t.test('canonical order survives grant, repeat and revoke', async t => {
      const f = fake(t)
      f.mode.readbackPushers = 'sorted'
      await f.access.ensureRoom('room')
      await f.access.grant('room', 'alice', 'alice')
      await f.access.grant('room', 'bob', 'bob')
      await f.access.grant('room', 'alice', 'alice')
      assert.deepEqual((await f.access.effective('room')).chat, ['alice', 'bob', 'root'])
      await f.access.revoke('room', 'alice', 'alice')
      assert.deepEqual((await f.access.effective('room')).chat, ['bob', 'root'])
    })
    for (const mode of ['missing', 'extra', 'duplicate']) await t.test(mode, async t => {
      const f = fake(t)
      await f.access.ensureRoom('room')
      f.mode.readbackPushers = mode
      await assert.rejects(f.access.grant('room', 'alice', 'alice'), /policy did not take effect/)
    })
  })

  it('reads the supported API and rejects unknown versions before making anything', async t => {
    const f = fake(t)
    assert.equal((await f.access.inspect()).version, '1.25.0')
    assert.deepEqual((await f.access.inspect()).can, {actorBranches: true, privateRepos: true, deleteServer: true,
      refuseForcePush: true, accountKeys: true, deployKeys: false, hostKeysByApi: false})
    for (const v of ['1.24.9', '1.28.0', '2.0.0', 'unknown']) {
      f.mode.version = v
      await assert.rejects(f.access.ensureRoom('no'), /supported 1.25/)
      await assert.rejects(f.access.ownKey('ssh-ed25519 AAAA'), /supported 1.25/)
    }
    assert.deepEqual(f.writes, [])
    f.mode.version = '1.27.0'
    assert.equal((await f.access.inspect()).version, '1.27.0')
  })

  it('puts exact root rules before the catchall, including actors admitted later', async t => {
    const f = fake(t)
    assert.deepEqual(await f.access.ensureRoom('room'), {address: 'git+ssh://git@gitea.example.invalid/team/room.git'})
    await f.access.grant('room', 'alice', 'alice')
    await f.access.grant('room', 'bob', 'bob')
    await f.access.grant('room', 'alice', 'alice')
    assert.deepEqual(f.pushers('room', 'main'), ['root'])
    assert.deepEqual(f.pushers('room', 'chat'), ['root', 'alice', 'bob'])
    assert.deepEqual(f.pushers('room', 'alice/signals'), ['alice'])
    assert.deepEqual(f.pushers('room', 'bob/signals'), ['bob'])
    assert.deepEqual(f.pushers('room', 'operator/signals'), ['root'])
    assert.deepEqual(f.pushers('room', 'invented/branch'), [])
    assert.equal(f.repos.get('room')!.rules.length, 6)
    assert(f.repos.get('room')!.rules.every(r => !r.enable_force_push))
    await f.access.ensureRoom('room')
    assert.deepEqual(await f.access.effective('room'), {main: ['root'], chat: ['root', 'alice', 'bob'], signals: {operator: 'root', alice: 'alice', bob: 'bob'}})
  })

  it('reads all account keys despite a server page cap and never follows hostile Link URLs', async t => {
    const f = fake(t)
    f.users.get('alice')!.keys.push('ssh-ed25519 AAAA1', 'ssh-ed25519 AAAA2 comment', 'ssh-ed25519 AAAA3')
    f.mode.hostileLink = true
    assert.deepEqual(await f.access.account!('Alice'), {id: '2', login: 'alice'})
    assert.equal(await f.access.account!('nobody'), null)
    assert.deepEqual(await f.access.accountKeys!({id: '2', login: 'alice'}), ['ssh-ed25519 AAAA1', 'ssh-ed25519 AAAA2', 'ssh-ed25519 AAAA3'])
    await assert.rejects(f.access.accountKeys!({id: '9', login: 'alice'}), /not the account it was/)
    f.mode.badKeys = true
    await assert.rejects(f.access.accountKeys!({id: '2', login: 'alice'}), /not a list of the requested records/)
  })

  it('enrols only the root key, using the whole key list and stable fingerprint titles', async t => {
    const f = fake(t)
    f.users.get('root')!.keys.push('ssh-ed25519 AAAA1', 'ssh-ed25519 AAAA2', 'ssh-ed25519 AAAA3')
    await f.access.ownKey('ssh-ed25519 AAAA3 another-comment')
    assert.equal(f.writes.length, 0)
    await f.access.ownKey('ssh-ed25519 AAAA4')
    await f.access.ownKey('ssh-ed25519 AAAA4 comment')
    assert.equal(f.writes.filter(x => x === 'POST /user/keys').length, 1)
    await f.access.ensureRoom('room')
    await assert.rejects(f.access.grant('room', 'alice', 'alice', 'ssh-ed25519 AAAA'), /enrolled by their owner/)
    assert(!f.writes.some(x => x.includes('/admin/')))
  })

  it('refuses inconsistent pagination and reports rate limits without retrying', async t => {
    const f = fake(t)
    f.mode.total = '2'
    await assert.rejects(f.access.accountKeys!({id: '2', login: 'alice'}), /incomplete list/)
    f.mode.total = 'unknown'
    await assert.rejects(f.access.accountKeys!({id: '2', login: 'alice'}), /inconsistent list count/)
    f.mode.total = ''; f.mode.fail = 'GET /user/keys'; f.mode.status = 429
    await assert.rejects(f.access.ownKey('ssh-ed25519 AAAA'), /429.*retry after 17/)
    assert.equal(f.calls.filter(x => x === 'GET /user/keys').length, 1)
    assert.equal(f.writes.length, 0)
  })

  it('finishes an interrupted revoke without deleting another actor or duplicating a rule', async t => {
    const f = fake(t)
    await f.access.ensureRoom('room')
    await f.access.grant('room', 'alice', 'alice')
    await f.access.grant('room', 'bob', 'bob')
    f.mode.fail = 'PATCH /repos/team/room/branch_protections/chat'
    await assert.rejects(f.access.revoke('room', 'alice', 'alice'), /503/)
    assert(!f.repos.get('room')!.rules.some(r => r.rule_name === 'alice/signals'))
    await f.access.revoke('room', 'alice', 'alice')
    await f.access.revoke('room', 'alice', 'alice')
    assert.deepEqual((await f.access.effective('room')).signals, {operator: 'root', bob: 'bob'})
    assert.deepEqual(f.pushers('room', 'chat'), ['root', 'bob'])
    assert.equal(f.repos.get('room')!.collaborators.get('alice'), undefined)
    f.mode.permission = 'unknown'
    await assert.rejects(f.access.revoke('room', 'alice', 'alice'), /still writes/)
  })

  it('refuses malformed, widened, duplicated and misordered policy before grant or revoke writes', async t => {
    const f = fake(t)
    await f.access.ensureRoom('room')
    await f.access.grant('room', 'alice', 'alice')
    const r = f.repos.get('room')!, saved = structuredClone(r.rules)
    const bad: Array<(rows: Rule[]) => void> = [
      rows => { rows[0].enable_force_push = true },
      rows => { rows[0].push_whitelist_teams = ['foreign-team'] },
      rows => { rows[0].unprotected_file_patterns = '*' },
      rows => { rows[0].rule_name = 'foreign/*' },
      rows => { rows[0].priority = 999 },
      rows => { rows.push({...rows[0]}) },
      rows => { delete (rows[0] as Partial<Rule>).enable_force_push },
      rows => { rows.splice(rows.findIndex(x => x.rule_name === 'chat'), 1) },
      rows => { rows.splice(rows.findIndex(x => x.rule_name === 'main'), 1) },
      rows => { rows.splice(rows.findIndex(x => x.rule_name === '**'), 1) },
      rows => { rows.splice(rows.findIndex(x => x.rule_name === 'operator/signals'), 1) },
    ]
    for (const change of bad) {
      r.rules = structuredClone(saved); change(r.rules)
      const before = f.writes.length
      await assert.rejects(f.access.grant('room', 'bob', 'bob'), /Gitea/)
      await assert.rejects(f.access.revoke('room', 'alice', 'alice'), /Gitea/)
      assert.equal(f.writes.length, before)
    }
    r.rules = saved
  })

  it('checks the requested actor and principal before changing a policy', async t => {
    const f = fake(t)
    await f.access.ensureRoom('room')
    await f.access.grant('room', 'alice', 'alice')
    const before = f.writes.length
    await assert.rejects(f.access.grant('room', 'bad/*', 'bob'), /invalid Gitea actor/)
    await assert.rejects(f.access.grant('room', 'operator', 'alice'), /root account/)
    await assert.rejects(f.access.grant('room', 'bob', 'ROOT'), /root account/)
    await assert.rejects(f.access.grant('room', 'bob', 'alice'), /another actor/)
    await assert.rejects(f.access.grant('room', 'bob', 'ALICE'), /another actor/)
    await assert.rejects(f.access.grant('room', 'bob', 'unknown-account'), /no account/)
    await assert.rejects(f.access.grant('room', 'bob', ''), /account login/)
    await assert.rejects(f.access.revoke('room', 'alice', 'bob'), /another account/)
    assert.equal(f.writes.length, before)
    await f.access.revoke('room', 'alice', 'ALICE')
    assert(!f.repos.get('room')!.collaborators.has('alice'))
    await f.access.grant('room', 'constructor', 'alice')
    assert.equal((await f.access.effective('room')).signals.constructor, 'alice')
    await f.access.revoke('room', 'constructor', 'alice')
  })

  it('refuses a public repository, changed privacy, wrong tags and ignored priority readback', async t => {
    const f = fake(t)
    await f.access.ensureRoom('room')
    const r = f.repos.get('room')!
    r.private = false
    const before = f.writes.length
    await assert.rejects(f.access.ensureRoom('room'), /not private/)
    await assert.rejects(f.access.grant('room', 'alice', 'alice'), /not private/)
    assert.equal(f.writes.length, before)
    r.private = true
    r.tags[0].whitelist_usernames.push('stranger')
    await assert.rejects(f.access.grant('room', 'alice', 'alice'), /tags are not closed/)
    r.tags[0].whitelist_usernames = ['root']
    f.mode.ignorePriority = true
    await assert.rejects(f.access.grant('room', 'alice', 'alice'), /precede the deny fallback/)
  })

  it('reads back server deletion and rejects token permissions or another provider address', async t => {
    const f = fake(t)
    await f.access.ensureRoom('room')
    f.mode.keepDeleted = true
    await assert.rejects(f.access.deleteServer('room'), /still on Gitea/)
    f.mode.keepDeleted = false
    await f.access.deleteServer('room')
    await f.access.deleteServer('room')
    fs.chmodSync(f.auth, 0o644)
    await assert.rejects(f.access.inspect(), /chmod 600/)
    assert.throws(() => giteaAccess('forgejo://gitea.example.invalid/team', f.auth), /not a Gitea space/)
    assert.throws(() => giteaAccess('gitea://user:pass@gitea.example.invalid/team', f.auth), /credential|password|userinfo/)
  })
})
