// The GitHub access adapter against a fake GitHub API on localhost, and a room in a GitHub space through the command
// line in deploy-key mode. A fake proves the mapping, not GitHub's own rules.
import {describe, it} from 'node:test'
import type {TestContext} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {spawn, spawnSync} from 'node:child_process'
import {githubAccess} from '../../main/ts/adapters/access-github/index.ts'
import {BASE, BIN} from './cli.ts'

type Key = {id: number, key: string, title: string, read_only: boolean}
type Repo = {name: string, private: boolean, keys: Key[], collaborators: string[]}
const HOST_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl'

// A GitHub that knows one organisation, one token and the calls the adapter makes; a page holds two entries.
const fake = async (t: TestContext, served?: string) => {
  const repos = new Map<string, Repo>(), writes: string[] = []
  const users = new Map<string, {id: number, keys: string[], type: string}>([['root', {id: 1, keys: [], type: 'User'}],
    ['claude-vm', {id: 2, keys: [], type: 'User'}], ['team-bot', {id: 3, keys: [], type: 'Organization'}]])
  const org: {plan: {name: string}, default_repository_permission?: string} = {plan: {name: 'free'}, default_repository_permission: 'read'}
  let nextKey = 100, limited = false, linkTo: ((page: number) => string) | null = null
  const body = (req: http.IncomingMessage): Promise<Record<string, unknown>> => new Promise(done => {
    let s = ''
    req.on('data', c => { s += c })
    req.on('end', () => done(s ? JSON.parse(s) : {}))
  })
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url!, 'http://x'), send = (status: number, value?: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, {'Content-Type': 'application/json', ...headers}); res.end(value === undefined ? '' : JSON.stringify(value))
    }
    // A list, two entries a page, the next page in a Link header as GitHub sends it.
    const list = (all: unknown[]) => {
      const page = Number(u.searchParams.get('page') ?? 1), more = all.length > page * 2
      const to = linkTo ?? (n => `http://${req.headers.host}${u.pathname}?per_page=100&page=${n}`)
      const link: Record<string, string> = more ? {link: `<${to(page + 1)}>; rel="next"`} : {}
      return send(200, all.slice((page - 1) * 2, page * 2), link)
    }
    if (req.headers.authorization !== 'Bearer s3cret') return send(401, {message: 'Bad credentials'})
    if (limited) return send(403, {message: 'API rate limit exceeded'}, {'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 60)})
    const p = decodeURIComponent(u.pathname.replace('/api/v3', '')), b = req.method === 'GET' ? {} : await body(req)
    if (req.method !== 'GET') writes.push(`${req.method} ${p}`)
    if (p === '/user') return send(200, {login: 'root'})
    if (p === '/orgs/ringi') return send(200, org)
    if (p === '/meta') return send(200, {ssh_keys: [HOST_KEY]})
    if (p === '/user/keys' && req.method === 'POST') { users.get('root')!.keys.push(String(b.key)); return send(201, {}) }
    if (p === '/user/keys') return list(users.get('root')!.keys.map(key => ({key})))
    // Logins are case-insensitive; GitHub answers with the account's own spelling.
    const user = /^\/users\/([^/]+)(\/keys)?$/.exec(p), login = user ? [...users.keys()].find(n => n.toLowerCase() === user[1].toLowerCase()) : undefined, who = login ? users.get(login) : undefined
    if (user && !who) return send(404, {message: 'Not Found'})
    if (user && user[2]) return list(who!.keys.map(key => ({key})))
    if (user) return send(200, {id: who!.id, login, type: who!.type})
    const sshUrl = (name: string) => served ? `file://${path.join(served, `${name}.git`)}` : `git@github.com:ringi/${name}.git`
    if (p === '/orgs/ringi/repos' && req.method === 'POST') {
      repos.set(String(b.name), {name: String(b.name), private: !!b.private, keys: [], collaborators: ['root']})
      if (served) spawnSync('git', ['init', '-q', '--bare', '-b', 'main', path.join(served, `${b.name}.git`)])
      return send(201, {ssh_url: sshUrl(String(b.name))})
    }
    const m = /^\/repos\/ringi\/([^/]+)(\/.*)?$/.exec(p), r = m && repos.get(m[1]), rest = m?.[2] ?? ''
    if (!r) return send(404, {message: 'Not Found'})
    if (rest === '' && req.method === 'GET') return send(200, {ssh_url: sshUrl(r.name), private: r.private})
    if (rest === '' && req.method === 'DELETE') { repos.delete(r.name); return send(204) }
    if (rest === '/collaborators') return list(r.collaborators.map(login => ({login})))
    if (rest === '/keys' && req.method === 'POST') {
      if ([...repos.values()].some(x => x.keys.some(k => k.key === b.key))) return send(422, {message: 'Validation Failed', errors: [{message: 'key is already in use'}]})
      const k = {id: nextKey++, key: String(b.key), title: String(b.title), read_only: !!b.read_only}
      r.keys.push(k)
      return send(201, k)
    }
    if (rest === '/keys') return list(r.keys)
    const key = /^\/keys\/(\d+)$/.exec(rest), k = key && r.keys.find(x => x.id === Number(key[1]))
    if (key && req.method === 'DELETE') { r.keys = r.keys.filter(x => x !== k); return send(204) }
    if (key) return k ? send(200, k) : send(404, {message: 'Not Found'})
    return send(404, {message: 'Not Found'})
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  t.after(() => server.close())
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ringi-github-'))
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}))
  const auth = path.join(dir, 'token')
  fs.writeFileSync(auth, 's3cret\n', {mode: 0o600})
  const {port} = server.address() as {port: number}, space = `github://127.0.0.1:${port}/ringi`
  return {repos, writes, users, org, auth, space, port, access: githubAccess(space, auth), limit: () => { limited = true }, link: (to: (page: number) => string) => { linkTo = to }}
}

describe('access: github', () => {
  it('makes a private room repository the root alone writes, and reports what GitHub enforces', async t => {
    const f = await fake(t)
    assert.deepEqual(await f.access.inspect(), {version: 'GitHub (free)', principal: 'root',
      can: {actorBranches: false, privateRepos: true, deleteServer: true, refuseForcePush: false, accountKeys: true, deployKeys: true, hostKeysByApi: true}})
    assert.deepEqual(await f.access.ensureRoom('fix'), {address: 'git+ssh://git@github.com/ringi/fix.git'})
    assert.equal(f.repos.get('fix')!.private, true)
    const before = f.writes.length
    await f.access.ensureRoom('fix')
    assert.equal(f.writes.length, before, 'nothing is made twice')
    assert.deepEqual(await f.access.hostKeys!(), [`127.0.0.1 ${HOST_KEY}`])
    // Whoever writes a room on GitHub writes every branch of it.
    assert.deepEqual(await f.access.effective('fix'), {main: ['root'], chat: ['root'], signals: {}})
    await assert.rejects(f.access.grant('fix', 'claude', 'claude-vm'), /deploy keys here/)
  })

  it('refuses a public repository, an organisation every member writes, and a collaborator besides the root', async t => {
    const f = await fake(t)
    await f.access.ensureRoom('fix')
    f.repos.get('fix')!.collaborators.push('stranger')
    await assert.rejects(f.access.ensureRoom('fix'), /other collaborators \(stranger\)/)
    f.org.default_repository_permission = 'write'
    await assert.rejects(f.access.ensureRoom('two'), /every member of ringi may write/)
    // A policy GitHub does not show this token is no proof: only an owner sees it.
    for (const base of [undefined, 'unrecognized']) {
      f.org.default_repository_permission = base
      await assert.rejects(f.access.ensureRoom('three'), /shows this token no base permission of ringi/)
    }
    assert.equal(f.repos.has('two') || f.repos.has('three'), false, 'nothing is made before the policy is read')
    f.org.default_repository_permission = 'none'
    f.repos.get('fix')!.private = false
    await assert.rejects(f.access.ensureRoom('fix'), /exists on GitHub and is public/)
  })

  it('reads an account and all its keys across pages, and a deploy key per actor by its record', async t => {
    const f = await fake(t)
    await f.access.ensureRoom('fix')
    f.users.get('claude-vm')!.keys.push('ssh-ed25519 AAAA1', 'ssh-ed25519 AAAA2', 'ssh-ed25519 AAAA3 comment')
    assert.deepEqual(await f.access.account!('Claude-VM'), {id: '2', login: 'claude-vm'})
    assert.equal(await f.access.account!('nobody'), null)
    await assert.rejects(f.access.account!('team-bot'), /no user account/)
    assert.deepEqual(await f.access.accountKeys!({id: '2', login: 'claude-vm'}), ['ssh-ed25519 AAAA1', 'ssh-ed25519 AAAA2', 'ssh-ed25519 AAAA3'])
    await assert.rejects(f.access.accountKeys!({id: '9', login: 'claude-vm'}), /not the account it was/)
    const k = await f.access.deployKey!('fix', 'claude-vm', 'ssh-ed25519 AAAAK made-here')
    assert.deepEqual(k, {record: '100', key: 'ssh-ed25519 AAAAK', title: 'claude-vm'})
    assert.deepEqual(await f.access.deployKey!('fix', 'claude-vm', 'ssh-ed25519 AAAAK'), k, 'the same key again is the same record')
    await assert.rejects(f.access.deployKey!('fix', 'other', 'ssh-ed25519 AAAAK'), /as claude-vm already/)
    await f.access.ensureRoom('two')
    await assert.rejects(f.access.deployKey!('two', 'claude-vm', 'ssh-ed25519 AAAAK'), /key is already in use/)
    assert.deepEqual(await f.access.effective('fix'), {main: ['root', 'claude-vm'], chat: ['root', 'claude-vm'], signals: {}})
    await f.access.dropDeployKey!('fix', k.record)
    assert.deepEqual(await f.access.deployKeys!('fix'), [])
  })

  it('sends its token to no next page but its own API\'s', async t => {
    const f = await fake(t)
    f.users.get('claude-vm')!.keys.push('ssh-ed25519 AAAA1', 'ssh-ed25519 AAAA2', 'ssh-ed25519 AAAA3')
    for (const to of [(n: number) => `http://127.0.0.1.attacker.invalid:${f.port}/api/v3/users/claude-vm/keys?page=${n}`,
      (n: number) => `http://127.0.0.1:${f.port}/api/v30/users/claude-vm/keys?page=${n}`,
      (n: number) => `http://user:pass@127.0.0.1:${f.port}/api/v3/users/claude-vm/keys?page=${n}`]) {
      f.link(to)
      await assert.rejects(f.access.accountKeys!({id: '2', login: 'claude-vm'}), /sent the next page to another place/)
    }
    f.link(n => `/api/v3/users/claude-vm/keys?per_page=100&page=${n}`)
    assert.equal((await f.access.accountKeys!({id: '2', login: 'claude-vm'})).length, 3, 'a relative next page is its own')
  })

  it('says when GitHub\'s rate limit lifts, and refuses a token others read and a space that is not one organisation', async t => {
    const f = await fake(t)
    f.limit()
    await assert.rejects(f.access.inspect(), /403 .*rate limit exceeded.*lifts in \d+ s/)
    fs.chmodSync(f.auth, 0o644)
    await assert.rejects(f.access.inspect(), /readable by others; chmod 600/)
    assert.throws(() => githubAccess('forgejo://forge.example/ringi', f.auth), /not a GitHub space/)
    assert.throws(() => githubAccess('github://github.com/ringi/team', f.auth), /one organisation/)
  })
})

describe('rooms in a GitHub space, through the command line', () => {
  it('admits an actor with a deploy key of the room the root vouches for, and removes it for good', async t => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ringi-ghspace-'))
    t.after(() => fs.rmSync(base, {recursive: true, force: true}))
    const served = path.join(base, 'forge')
    fs.mkdirSync(served)
    const f = await fake(t, served)
    const run = (home: string, args: string[], session?: string) => new Promise<{code: number | null, out: string, err: string}>(done => {
      const child = spawn(BIN[0], [...BIN.slice(1), ...args], {env: {...BASE, RINGI_HOME: home, ...(session ? {RINGI_SESSION: session} : {})}})
      let out = '', err = ''
      child.stdout.on('data', (c: Buffer) => { out += c })
      child.stderr.on('data', (c: Buffer) => { err += c })
      child.on('close', (code: number | null) => done({code, out, err}))
    })
    const ok = async (home: string, args: string[], session?: string) => { const r = await run(home, args, session); assert.equal(r.code, 0, `ringi ${args.join(' ')}: ${r.err}`); return r.out }
    const op = path.join(base, 'op'), agent = path.join(base, 'agent'), room = `${f.space}/fix`
    // A free organisation keeps no account to its own branch: account mode refuses before anything is made.
    assert.match((await run(op, ['room', 'create', room, '--token-file', f.auth, '--mode', 'account'])).err, /cannot keep an account to its own branch/)
    assert.equal(f.repos.size, 0)
    // Without --host-key-file, GitHub's own host keys from its API are pinned.
    const made = await ok(op, ['room', 'create', room, '--token-file', f.auth, '--invite', 'claude-vm'])
    const invitation = /a deploy key joins as claude-vm: .*\n {2}ringi join (ringi:\S+)/.exec(made)![1]
    assert.equal(JSON.parse(Buffer.from(invitation.slice('ringi:'.length), 'base64url').toString()).mode, 'deploy-key')
    assert.match((await run(op, ['room', 'create', `${f.space}/next`, '--mode', 'account'])).err, /takes its actors in deploy-key mode/)
    const first = await run(agent, ['join', invitation], 'C')
    assert.equal(first.code, 3, first.err)
    assert.doesNotMatch(first.out, /add this key to/)
    const key = /ringi room admit claude-vm '([^']+)'/.exec(first.out)![1]
    // The root vouches for the key: no account shows it, the deploy key is made for the actor's label.
    assert.match(await ok(op, ['room', 'admit', 'claude-vm', key]), /admitted claude-vm to .* with a write deploy key/)
    assert.deepEqual((await f.access.deployKeys!('fix')).map(k => k.title), ['claude-vm'])
    assert.match(await ok(agent, ['join', invitation], 'C'), /joined github:\/\/127\.0\.0\.1:\d+\/ringi\/fix as claude-vm/)
    await ok(op, ['send', '--task', '--assign', 'claude-vm', '-m', 'Fix it'])
    const task = (JSON.parse(await ok(agent, ['agent', 'inbox', '--json'], 'C')) as Array<{id: string, kind: string, trust: string}>).find(m => m.kind === 'task')!
    assert.equal(task.trust, 'verified')
    await ok(agent, ['agent', 'reply', task.id, '--state', 'completed', '-m', 'Done'], 'C')
    assert.deepEqual((JSON.parse(await ok(op, ['tasks', '--all', '--json'])) as Array<{state: string, by: string}>).map(x => [x.state, x.by]), [['completed', 'claude-vm']])
    // Removal takes the deploy key back; the label returns only as a new actor with a new key.
    assert.match(await ok(op, ['room', 'remove', 'claude-vm']), /removed claude-vm from .*, and its rights on the forge/)
    assert.deepEqual(await f.access.deployKeys!('fix'), [])
    assert.match((await run(agent, ['agent', 'inbox'], 'C')).err, /claude-vm was removed from room/)
    assert.match(await ok(op, ['room', 'invite', 'claude-vm']), /a deploy key joins as claude-vm-2: /)
  })
})
