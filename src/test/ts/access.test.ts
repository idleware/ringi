// The Forgejo access adapter against a fake Forgejo API on localhost: what it asks for, that asking twice changes
// nothing, and that what it reports is what the API reads back. A fake proves the mapping, not a real server's rules.
import {describe, it} from 'node:test'
import type {TestContext} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {spawn, spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {forgejoAccess} from '../../main/ts/adapters/access-forgejo/index.ts'
import {stateFsV5} from '../../main/ts/adapters/state-fs/index.ts'
import {git4Transport} from '../../main/ts/adapters/store-git/transport-v4.ts'
import {keysFile} from '../../main/ts/adapters/keys-file/index.ts'
import {roomFiles} from '../../main/ts/adapters/location-fs/index.ts'
import {wireHub} from '../../main/ts/core/hub/ports/index.ts'
import * as Create from '../../main/ts/core/hub/usecases/room-create.ts'
import * as Rooms from '../../main/ts/core/hub/usecases/rooms.ts'
import * as Membership from '../../main/ts/core/hub/usecases/membership.ts'
import {deleteServerRoom} from '../../main/ts/core/hub/usecases/access.ts'
import {BASE, BIN} from './cli.ts'
import {fixtureAccess} from './access-fixture.ts'
import {identityCases} from './access-identity-cases.ts'

type Rule = {rule_name: string, enable_push: boolean, enable_push_whitelist: boolean, push_whitelist_usernames: string[], push_whitelist_deploy_keys: boolean}
type Repo = {id: number, name: string, private: boolean, chat?: boolean, rules: Rule[], collaborators: Map<string, string>, tags: Array<{name_pattern: string, whitelist_usernames: string[]}>}

// A Forgejo that knows one organisation, one token and the calls the adapter makes; it records every write.
const fake = async (t: TestContext, served?: string) => {
  const repos = new Map<string, Repo>(), writes: string[] = [], keys = new Map<string, string[]>([['root', []], ['claude-zurich', []], ['codex-amsterdam', []], ['operator', []]])
  // Forgejo keeps one title per key on an account, and refuses a second key titled alike.
  const titles = new Map<string, string[]>()
  const addKey = (user: string, b: Record<string, unknown>) => {
    const ts = titles.get(user) ?? []
    if (ts.includes(String(b.title))) return 422
    titles.set(user, [...ts, String(b.title)])
    keys.get(user)!.push(String(b.key))
    return 201
  }
  let admin = true, keepDeleted = false, ownKeyFails = false, keysMalformed = false, nextRepo = 1
  const ids = new Map([...keys.keys()].map((u, i) => [u, i + 1]))
  const body = (req: http.IncomingMessage): Promise<Record<string, unknown>> => new Promise(done => {
    let s = ''
    req.on('data', c => { s += c })
    req.on('end', () => done(s ? JSON.parse(s) : {}))
  })
  const server = http.createServer(async (req, res) => {
    const send = (status: number, value?: unknown) => { res.writeHead(status, {'Content-Type': 'application/json'}); res.end(value === undefined ? '' : JSON.stringify(value)) }
    if (req.headers.authorization !== 'token s3cret') return send(401, {message: 'unauthorized'})
    const url = decodeURIComponent(new URL(req.url!, 'http://x').pathname.replace('/api/v1', '')), q = new URL(req.url!, 'http://x').searchParams
    const b = req.method === 'GET' ? {} : await body(req)
    if (req.method !== 'GET') writes.push(`${req.method} ${url}`)
    if (url === '/version') return send(200, {version: '13.0.0'})
    if (url === '/user') return send(200, {login: 'root'})
    if (url === '/user/keys' && req.method === 'POST') {
      if (ownKeyFails) { ownKeyFails = false; return send(500, {message: 'the forge is busy'}) }
      const status = addKey('root', b)
      return send(status, status === 422 ? {message: 'Key title has been used'} : {})
    }
    if (url === '/user/keys') return send(200, keys.get('root')!.map(key => ({key})))
    const named = /^\/users\/([^/]+)$/.exec(url)
    if (named) return keys.has(named[1]) ? send(200, {id: ids.get(named[1]), login: named[1]}) : send(404, {})
    const user = /^\/users\/([^/]+)\/keys$/.exec(url)
    if (user && keysMalformed) return send(200, {not: 'a list'})
    // A page of 30 at most, whatever the limit asked: as a forge with a smaller page size answers.
    const page = Number(q.get('page') ?? 0), size = Math.min(Number(q.get('limit') ?? 30), 30)
    if (user) return keys.has(user[1]) ? send(200, keys.get(user[1])!.slice(page ? (page - 1) * size : 0, page ? page * size : undefined).map(key => ({key}))) : send(404, {})
    const enrol = /^\/admin\/users\/([^/]+)\/keys$/.exec(url)
    if (enrol) { if (!admin) return send(403, {message: 'forbidden'}); const status = addKey(enrol[1], b); return send(status, status === 422 ? {message: 'Key title has been used'} : {}) }
    const sshUrl = (name: string) => served ? `file://${path.join(served, `${name}.git`)}` : `ssh://git@forge.test:2222/ringi/${name}.git`
    if (url === '/orgs/ringi/repos' && req.method === 'POST') {
      const r: Repo = {id: nextRepo++, name: String(b.name), private: !!b.private, rules: [], collaborators: new Map(), tags: []}
      repos.set(r.name, r)
      if (served) spawnSync('git', ['init', '-q', '--bare', '-b', 'main', path.join(served, `${r.name}.git`)])
      return send(201, {id: r.id, private: r.private, ssh_url: sshUrl(r.name)})
    }
    const m = /^\/repos\/ringi\/([^/]+)(\/.*)?$/.exec(url)
    const r = m && repos.get(m[1])
    if (!m) return send(404, {})
    if (!r) return send(404, {})
    const rest = m[2] ?? ''
    if (rest === '' && req.method === 'GET') return send(200, {id: r.id, ssh_url: sshUrl(r.name), private: r.private})
    if (rest === '/branches/chat') return send(r.chat || served && spawnSync('git', ['--git-dir', path.join(served, `${r.name}.git`), 'show-ref', '--verify', '--quiet', 'refs/heads/chat']).status === 0 ? 200 : 404, {})
    if (rest === '' && req.method === 'DELETE') { if (!keepDeleted) repos.delete(r.name); return send(204) }
    if (rest === '/branch_protections' && req.method === 'GET') return send(200, r.rules)
    if (rest === '/branch_protections' && req.method === 'POST') { r.rules.push(b as unknown as Rule); return send(201, b) }
    const rule = /^\/branch_protections\/(.+)$/.exec(rest)
    if (rule && req.method === 'PATCH') { Object.assign(r.rules.find(x => x.rule_name === rule[1])!, b); return send(200, {}) }
    if (rule && req.method === 'DELETE') { r.rules = r.rules.filter(x => x.rule_name !== rule[1]); return send(204) }
    if (rest === '/tag_protections' && req.method === 'GET') return send(200, r.tags)
    if (rest === '/tag_protections' && req.method === 'POST') {
      if (!(b.whitelist_usernames as string[] | undefined)?.length && !(b.whitelist_teams as string[] | undefined)?.length) return send(400, {message: 'both whitelist_usernames and whitelist_teams are empty'})
      r.tags.push(b as unknown as Repo['tags'][number]); return send(201, b)
    }
    const can = /^\/collaborators\/(.+)\/permission$/.exec(rest)
    if (can) return send(200, {permission: r.collaborators.get(can[1]) ?? 'none'})
    const who = /^\/collaborators\/(.+)$/.exec(rest)
    if (who && req.method === 'PUT') { r.collaborators.set(who[1], String(b.permission)); return send(204) }
    if (who && req.method === 'DELETE') { r.collaborators.delete(who[1]); return send(204) }
    return send(404, {})
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  t.after(() => server.close())
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ringi-access-'))
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}))
  const auth = path.join(dir, 'token')
  fs.writeFileSync(auth, 's3cret\n', {mode: 0o600})
  const {port} = server.address() as {port: number}
  return {repos, writes, keys, auth, space: `forgejo://127.0.0.1:${port}/ringi`, noAdmin: () => { admin = false }, keepDeleted: () => { keepDeleted = true },
    titled: (user: string, key: string, title: string) => { keys.get(user)!.push(key); titles.set(user, [...titles.get(user) ?? [], title]) },
    ownKeyFailsOnce: () => { ownKeyFails = true },
    keysMalformed: () => { keysMalformed = true },
    access: fixtureAccess(forgejoAccess(`forgejo://127.0.0.1:${port}/ringi`, auth))}
}

describe('access: forgejo', () => {
  identityCases(fake)
  it('makes a private room repository that only the root may push, its own signals too, and asking again changes nothing', async t => {
    const f = await fake(t)
    assert.deepEqual(await f.access.inspect(), {version: '13.0.0', principal: 'root', can: {actorBranches: true, privateRepos: true, deleteServer: true, refuseForcePush: true, accountKeys: true, deployKeys: false, hostKeysByApi: false}})
    assert.deepEqual(await f.access.ensureRoom('fix'), {address: 'git+ssh://git@forge.test:2222/ringi/fix.git'})
    const repo = f.repos.get('fix')!
    assert.equal(repo.private, true)
    assert.deepEqual(repo.rules.map(r => [r.rule_name, r.enable_push, r.enable_push_whitelist, r.push_whitelist_usernames, r.push_whitelist_deploy_keys]),
      [['main', true, true, ['root'], false], ['chat', true, true, ['root'], false], ['operator/signals', true, true, ['root'], false],
        ['**', false, true, [], false]])
    assert.deepEqual(repo.tags, [{name_pattern: '*', whitelist_usernames: ['root']}])
    const before = f.writes.filter(w => !w.startsWith('PATCH')).length
    await f.access.ensureRoom('fix')
    assert.equal(f.writes.filter(w => !w.startsWith('PATCH')).length, before, 'nothing is made twice')
    assert.deepEqual(await f.access.effective('fix'), {main: ['root'], chat: ['root'], signals: {operator: 'root'}})
  })

  it('gives an actor the room, chat and its own signals through its account, and takes them back', async t => {
    const f = await fake(t)
    await f.access.ensureRoom('fix')
    await f.access.grant('fix', 'claude', 'claude-zurich')
    await f.access.grant('fix', 'codex', 'codex-amsterdam')
    await f.access.grant('fix', 'claude', 'claude-zurich')
    const both = {main: ['root'], chat: ['root', 'claude-zurich', 'codex-amsterdam'], signals: {operator: 'root', claude: 'claude-zurich', codex: 'codex-amsterdam'}}
    assert.deepEqual(await f.access.effective('fix'), both)
    assert.deepEqual([...f.repos.get('fix')!.collaborators], [['claude-zurich', 'write'], ['codex-amsterdam', 'write']])
    // A revocation names the account the actor writes through, or takes nothing back.
    await assert.rejects(f.access.revoke('fix', 'claude', 'codex-amsterdam'), /codex-amsterdam writes codex's signals in ringi\/fix, not claude's; nothing is revoked/)
    await assert.rejects(f.access.revoke('fix', 'claude', 'someone'), /claude writes ringi\/fix through claude-zurich, not someone; nothing is revoked/)
    await assert.rejects(f.access.revoke('fix', 'operator', 'root'), /the operator's signals are the root's/)
    // An account listed on another actor's stream, however loose that rule, is that actor's too: nothing is taken back.
    const theirs = f.repos.get('fix')!.rules.find(r => r.rule_name === 'codex/signals')!, writes = f.writes.length
    Object.assign(theirs, {push_whitelist_usernames: ['codex-amsterdam', 'claude-zurich'], push_whitelist_teams: ['other-team']})
    await assert.rejects(f.access.revoke('fix', 'claude', 'claude-zurich'), /claude-zurich writes codex's signals in ringi\/fix, not claude's; nothing is revoked/)
    assert.equal(f.writes.length, writes, 'a refused revocation writes nothing')
    Object.assign(theirs, {push_whitelist_usernames: ['codex-amsterdam'], push_whitelist_teams: []})
    assert.deepEqual(await f.access.effective('fix'), both)
    const after = {main: ['root'], chat: ['root', 'codex-amsterdam'], signals: {operator: 'root', codex: 'codex-amsterdam'}}
    await f.access.revoke('fix', 'claude', 'claude-zurich')
    await f.access.revoke('fix', 'claude', 'claude-zurich')
    assert.deepEqual(await f.access.effective('fix'), after)
    // A revocation left half done, the signals rule gone and the chat and repository still the account's, is finished
    // by asking again.
    const rules = () => f.repos.get('fix')!.rules
    await f.access.grant('fix', 'claude', 'claude-zurich')
    rules().splice(rules().findIndex(r => r.rule_name === 'claude/signals'), 1)
    await f.access.revoke('fix', 'claude', 'claude-zurich')
    assert.deepEqual(await f.access.effective('fix'), after)
    assert.deepEqual([...f.repos.get('fix')!.collaborators.keys()], ['codex-amsterdam'])
    // The actor's signals rule must name only this account, and let no more than it names, or nothing is taken back.
    await f.access.grant('fix', 'claude', 'claude-zurich')
    const mine = rules().find(r => r.rule_name === 'claude/signals')!
    mine.push_whitelist_usernames = ['someone-else']
    await assert.rejects(f.access.revoke('fix', 'claude', 'claude-zurich'), /claude writes ringi\/fix through someone-else, not claude-zurich; nothing is revoked/)
    mine.enable_push_whitelist = false
    await assert.rejects(f.access.revoke('fix', 'claude', 'claude-zurich'), /claude\/signals in ringi\/fix lets more than the accounts it names; nothing is revoked/)
    assert.equal(rules().includes(mine), true, 'a refused revocation drops no rule')
    Object.assign(mine, {push_whitelist_usernames: ['claude-zurich'], enable_push_whitelist: true})
    await f.access.revoke('fix', 'claude', 'claude-zurich')
    assert.deepEqual(await f.access.effective('fix'), after)
    // Signals two accounts may push are a policy the forge does not keep as ringi wants: refused, not reported.
    rules().find(r => r.rule_name === 'codex/signals')!.push_whitelist_usernames = ['codex-amsterdam', 'someone-else']
    await assert.rejects(f.access.effective('fix'), /codex's signals do not let exactly one account push/)
    await f.access.deleteServer('fix')
    assert.equal(f.repos.has('fix'), false)
  })

  it('reads an account and every one of its keys page by page, or fails rather than shortens the list', async t => {
    const f = await fake(t)
    assert.equal(await f.access.account!('nobody'), null)
    const claude = (await f.access.account!('claude-zurich'))!
    assert.deepEqual(claude, {id: '2', login: 'claude-zurich'})
    for (let i = 0; i < 70; i++) f.titled('claude-zurich', `ssh-ed25519 AAAAKey${i} c${i}`, `k${i}`)
    const all = await f.access.accountKeys!(claude)
    assert.equal(all.length, 70, 'three short pages of a forge that pages by 30, read to the empty one')
    assert.equal(all[69], 'ssh-ed25519 AAAAKey69')
    await assert.rejects(f.access.accountKeys!({id: '9', login: 'claude-zurich'}), /not the account it was/)
    f.keysMalformed()
    await assert.rejects(f.access.accountKeys!(claude), /not a list of keys/)
  })

  it('puts the root\'s key on the token\'s own account once, beside other keys titled alike and another hub\'s', async t => {
    const f = await fake(t)
    f.titled('root', 'ssh-ed25519 AAAAForeign', 'ringi')
    for (let i = 0; i < 2; i++) await f.access.ownKey('ssh-ed25519 AAAARoot operator@ringi')
    await f.access.ownKey('ssh-ed25519 AAAAOtherHub operator@ringi')
    assert.deepEqual(f.keys.get('root'), ['ssh-ed25519 AAAAForeign', 'ssh-ed25519 AAAARoot', 'ssh-ed25519 AAAAOtherHub'])
  })

  it('puts an actor\'s key on its account once, or says where to add it when the token may not', async t => {
    const f = await fake(t)
    await f.access.ensureRoom('fix')
    const key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIClaude claude@ringi'
    await f.access.grant('fix', 'claude', 'claude-zurich', key)
    await f.access.grant('fix', 'claude', 'claude-zurich', key)
    assert.deepEqual(f.keys.get('claude-zurich'), ['ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIClaude'])
    f.noAdmin()
    await assert.rejects(f.access.grant('fix', 'codex', 'codex-amsterdam', 'ssh-ed25519 AAAACodex'), /add this key to codex-amsterdam's SSH keys on the forge by hand/)
    await assert.rejects(f.access.grant('fix', 'codex', 'nobody', 'ssh-ed25519 AAAACodex'), /no Forgejo account nobody/)
  })

  it('reports nothing it cannot vouch for: a wider rule, an open fallback or tag, a root or shared account', async t => {
    const f = await fake(t)
    await f.access.ensureRoom('fix')
    await f.access.grant('fix', 'claude', 'claude-zurich')
    await assert.rejects(f.access.grant('fix', 'codex', 'root'), /the root's account/)
    await assert.rejects(f.access.grant('fix', 'codex', 'claude-zurich'), /already writes claude's signals/)
    const repo = f.repos.get('fix')!
    const widen = async (change: () => void, undo: () => void, why: RegExp) => {
      change()
      await assert.rejects(f.access.effective('fix'), why)
      undo()
      await f.access.effective('fix')
    }
    const extra = {rule_name: 'release/*', enable_push: true, enable_push_whitelist: true, push_whitelist_usernames: ['claude-zurich'], push_whitelist_deploy_keys: false}
    await widen(() => repo.rules.push(extra), () => repo.rules.pop(), /rule release\/\*/)
    const fallback = repo.rules.find(r => r.rule_name === '**')!
    await widen(() => { fallback.enable_push = true }, () => { fallback.enable_push = false }, /no "\*\*" rule that lets nobody push/)
    const chat = repo.rules.find(r => r.rule_name === 'chat')!
    await widen(() => { chat.push_whitelist_deploy_keys = true }, () => { chat.push_whitelist_deploy_keys = false }, /rule chat lets every writer, teams, deploy keys or files through/)
    await widen(() => repo.tags[0].whitelist_usernames.push('claude-zurich'), () => repo.tags[0].whitelist_usernames.pop(), /tags are not closed to all but the root/)
    await widen(() => { repo.tags[0].whitelist_usernames = ['claude-zurich'] }, () => { repo.tags[0].whitelist_usernames = ['root'] }, /tags are not closed/)
    // Tags closed to everyone, as a forge may keep them when closed by hand, are narrower still.
    repo.tags[0].whitelist_usernames = []
    await f.access.effective('fix')
    repo.tags[0].whitelist_usernames = ['root']
    const mine = repo.rules.find(r => r.rule_name === 'claude/signals')!
    await widen(() => { mine.enable_push_whitelist = false }, () => { mine.enable_push_whitelist = true }, /rule claude\/signals lets every writer/)
    const stream = (name: string, who: string) => ({rule_name: name, enable_push: true, enable_push_whitelist: true, push_whitelist_usernames: [who], push_whitelist_deploy_keys: false})
    await widen(() => repo.rules.push(stream('*/signals', 'x')), () => repo.rules.pop(), /rule \*\/signals/)
    // A telemetry branch of an older ringi is no rule of this one's.
    await widen(() => repo.rules.push(stream('zoe/telemetry', 'someone')), () => repo.rules.pop(), /rule zoe\/telemetry/)
    await widen(() => repo.rules.push(stream('zoe/signals', 'claude-zurich')), () => repo.rules.pop(), /claude-zurich pushes the signals of claude and zoe/)
    await widen(() => repo.rules.push(stream('zoe/signals', 'root')), () => repo.rules.pop(), /root pushes the signals of operator and zoe/)
  })

  it('makes rooms only in private repositories, and says so when a deletion did not take', async t => {
    const f = await fake(t)
    await f.access.ensureRoom('fix')
    f.repos.get('fix')!.private = false
    await assert.rejects(f.access.ensureRoom('fix'), /exists on the forge and is public/)
    f.keepDeleted()
    await assert.rejects(f.access.deleteServer('fix'), /still on the forge after deleting it/)
  })

  it('refuses a token file others can read, and a space that is not one Forgejo organisation', async t => {
    const f = await fake(t)
    fs.chmodSync(f.auth, 0o644)
    await assert.rejects(f.access.inspect(), /readable by others; chmod 600/)
    assert.throws(() => forgejoAccess('https://forge.example/ringi', f.auth), /not a Forgejo space/)
    assert.throws(() => forgejoAccess('forgejo://forge.example/ringi/team', f.auth), /one organisation/)
    for (const space of ['forgejo://user:pass@forge.example/ringi', 'forgejo://forge.example/ringi?x=1', 'forgejo://forge.example/ringi#x'])
      assert.throws(() => forgejoAccess(space, f.auth), /no credentials, query or fragment/)
  })
})

describe('rooms in a space, through the command line', () => {
  it('makes the room there, invites an account, admits the key the forge shows on it, and removes it for good', async t => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ringi-forge-'))
    t.after(() => fs.rmSync(base, {recursive: true, force: true}))
    const served = path.join(base, 'forge')
    fs.mkdirSync(served)
    const f = await fake(t, served)
    // The fake listens in this process: the command line has to run beside it, not block it.
    const run = (home: string, args: string[], session?: string, env = {}) => new Promise<{code: number | null, out: string, err: string}>(done => {
      const child = spawn(BIN[0], [...BIN.slice(1), ...args], {env: {...BASE, RINGI_HOME: home, ...(session ? {RINGI_SESSION: session} : {}), ...env}})
      let out = '', err = ''
      child.stdout.on('data', (c: Buffer) => { out += c })
      child.stderr.on('data', (c: Buffer) => { err += c })
      child.on('close', (code: number | null) => done({code, out, err}))
    })
    const ok = async (home: string, args: string[], session?: string) => { const r = await run(home, args, session); assert.equal(r.code, 0, `ringi ${args.join(' ')}: ${r.err}`); return r.out }
    const op = path.join(base, 'op'), agent = path.join(base, 'agent'), room = `${f.space}/fix`
    assert.equal(spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(base, 'host')]).status, 0)
    const pins = path.join(base, 'known_hosts'), pin = `[forge.test]:2222 ${fs.readFileSync(path.join(base, 'host.pub'), 'utf8').trim().split(' ').slice(0, 2).join(' ')}`
    fs.writeFileSync(pins, `# the forge\n${pin}\n`)
    assert.match((await run(op, ['room', 'create', room])).err, /first room in forgejo:\/\/127\.0\.0\.1:\d+\/ringi needs --token-file/)
    assert.match((await run(op, ['room', 'create', room, '--token-file', f.auth])).err, /needs --host-key-file/)
    assert.match((await run(op, ['room', 'create', room, '--token-file', f.auth, '--host-key-file', pins, '--invite', 'nobody'])).err, /no account nobody in forgejo:\/\/127\.0\.0\.1:\d+/)
    assert.match((await run(op, ['room', 'create', 'here', '--invite', 'claude-zurich'])).err, /--invite is for a room in a space/)
    // An account that cannot name an actor refuses before anything is made, here or on the forge.
    assert.match((await run(op, ['room', 'create', room, '--token-file', f.auth, '--host-key-file', pins, '--invite', 'operator'])).err, /operator cannot name an actor/)
    assert.equal(f.repos.has('fix'), false)
    // A space whose root key could not go to the forge yet is kept; the room made next puts it there.
    f.ownKeyFailsOnce()
    assert.match((await run(op, ['room', 'create', room, '--token-file', f.auth, '--host-key-file', pins, '--invite', 'claude-zurich'])).err, /root key of .* is not on the forge yet: .*the forge is busy/)
    assert.equal(f.keys.get('root')!.length, 0)
    const made = await ok(op, ['room', 'create', room, '--invite', 'claude-zurich'])
    assert.equal(f.keys.get('root')!.length, 1, 'the root key is on the operator\'s account')
    assert.equal(f.repos.get('fix')!.private, true)
    assert.match(made, new RegExp(`created room ${room.replace(/[.]/g, '\\.')} with profile a2a-1`))
    const invitation = /claude-zurich joins as claude-zurich: .*\n {2}ringi join (ringi:\S+)/.exec(made)![1]
    const root = /the root of .*: (SHA256:\S+);/.exec(made)![1]
    // A create that stopped after its room was made finishes the root's list when run again, and says nothing new
    // once it is complete.
    const lists = fs.readdirSync(path.join(op, 'catalogue', 'rooms'), {recursive: true}).map(String).filter(x => x.endsWith('invitations.json'))
    assert.equal(lists.length, 1)
    fs.rmSync(path.join(op, 'catalogue', 'rooms', lists[0]))
    assert.equal(/ringi join (ringi:\S+)/.exec(await ok(op, ['room', 'create', room, '--invite', 'claude-zurich']))![1], invitation, 'the same invitation, not another')
    assert.match((await run(op, ['room', 'create', room, '--invite', 'claude-zurich'])).err, /room .*\/ringi\/fix exists/)
    assert.match((await run(op, ['room', 'create', room, '--invite', 'codex-amsterdam'])).err, /create retry changed its parameters/)
    // Over SSH the forge lets nobody read the room before the root admits them: the joiner is shown its key. Here ssh
    // is a stand-in that answers as a forge does to an unknown key.
    const bin = path.join(base, 'bin'), offer = JSON.parse(Buffer.from(invitation.slice('ringi:'.length), 'base64url').toString())
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'ssh'), '#!/bin/sh\necho "git@forge.test: Permission denied (publickey)." >&2\nexit 255\n', {mode: 0o755})
    const overSsh = 'ringi:' + Buffer.from(JSON.stringify({...offer, locator: 'git+ssh://git@forge.test:2222/ringi/fix.git', hostKeys: [pin]})).toString('base64url')
    const denied = await run(path.join(base, 'elsewhere'), ['join', overSsh], 'C', {PATH: `${bin}:${process.env.PATH}`})
    assert.equal(denied.code, 3, denied.err)
    assert.match(denied.out, /add this key to claude-zurich's SSH keys on forgejo:\/\/127\.0\.0\.1:\d+; then the root runs:\n {2}ringi room admit claude-zurich 'ssh-ed25519 /)
    assert.match((await run(agent, ['join', invitation, '--as', 'claude'], 'C')).err, /the invitation names the actor/)
    // Here the forge serves the room to anyone: reading it is not admission, the root's record is.
    const first = await run(agent, ['join', invitation], 'C')
    assert.equal(first.code, 3, first.err)
    const key = /ringi room admit claude-zurich '([^']+)'/.exec(first.out)![1]
    // Fingerprints the operator compares on both machines: the root this one pinned, and the key admit takes.
    assert.ok(first.out.includes(`the room's root, as this machine pinned it: ${root};`), first.out)
    const print = /'s key on this machine \((SHA256:\S+)\)/.exec(first.out)![1]
    assert.equal(/ringi room admit claude-zurich '([^']+)'/.exec((await run(agent, ['join', invitation], 'C')).out)![1], key, 'the key it was shown is the one it joins with')
    // The host vouches for the key: until it is on the invited account, nothing is written.
    assert.match((await run(op, ['room', 'admit', 'claude-zurich', key])).err, /this key is not on claude-zurich's SSH keys on the forge/)
    assert.match((await run(op, ['room', 'admit', 'mallory', key])).err, /mallory was never invited/)
    f.keys.get('claude-zurich')!.push(key)
    const admitted = await ok(op, ['room', 'admit', 'claude-zurich', key])
    assert.match(admitted, /admitted claude-zurich to .* as claude-zurich on the forge/)
    assert.ok(admitted.includes(`the key admitted: ${print},`), admitted)
    assert.deepEqual(await f.access.effective('fix'), {main: ['root'], chat: ['root', 'claude-zurich'], signals: {operator: 'root', 'claude-zurich': 'claude-zurich'}})
    assert.match(await ok(agent, ['join', invitation], 'C'), /joined forgejo:\/\/127\.0\.0\.1:\d+\/ringi\/fix as claude-zurich/)
    // The fake enforces no rules on a push: what both sides really push is held against the matrix instead.
    await ok(op, ['send', '--task', '--assign', 'claude-zurich', '-m', 'Fix it'])
    const task = (JSON.parse(await ok(agent, ['agent', 'inbox', '--json'], 'C')) as Array<{id: string, kind: string, trust: string}>).find(m => m.kind === 'task')!
    await ok(agent, ['agent', 'reply', task.id, '--state', 'completed', '-m', 'Done'], 'C')
    const refs = spawnSync('git', ['--git-dir', path.join(served, 'fix.git'), 'for-each-ref', '--format=%(refname)'], {encoding: 'utf8'}).stdout.trim().split('\n')
    assert.deepEqual(refs.filter(r => !r.startsWith('refs/heads/')), [], 'only branches are pushed')
    const {signals} = await f.access.effective('fix'), actorOf = (b: string) => /^([^/]+)\/signals$/.exec(b)?.[1]
    for (const b of refs.map(r => r.slice('refs/heads/'.length))) assert.ok(['main', 'chat'].includes(b) || signals[actorOf(b) ?? ''], `${b} is a branch the matrix lets someone push`)
    for (const b of ['operator/signals', 'claude-zurich/signals']) assert.ok(refs.includes(`refs/heads/${b}`), `${b} was pushed`)
    // Signed on one machine, verified on the other: the work, and the marks and signals beside it.
    assert.equal(task.trust, 'verified')
    assert.deepEqual((JSON.parse(await ok(op, ['tasks', '--all', '--json'])) as Array<{state: string, by: string}>).map(x => [x.state, x.by]), [['completed', 'claude-zurich']])
    const checked = JSON.parse(await ok(op, ['signals', '--all', '--json'])) as Array<{signal: string, actor: string, ok: boolean}>
    for (const s of ['state.completed', 'read']) assert.ok(checked.some(x => x.signal === s && x.actor === 'claude-zurich' && x.ok), `${s} was signed, published and verified`)
    // A record in the root's name that the root did not sign is withheld, whoever pushed it.
    const bare = path.join(served, 'fix.git'), keyFile = fs.readdirSync(path.join(agent, 'keys'), {recursive: true}).map(String).find(k => k.endsWith('claude-zurich'))!
    const asRoot = {...BASE, GIT_AUTHOR_NAME: 'operator', GIT_AUTHOR_EMAIL: 'operator@ringi', GIT_COMMITTER_NAME: 'operator', GIT_COMMITTER_EMAIL: 'operator@ringi'}
    const g = (...args: string[]) => spawnSync('git', ['--git-dir', bare, ...args], {encoding: 'utf8', env: asRoot}).stdout.trim()
    const tip = g('rev-parse', 'refs/heads/chat')
    g('update-ref', 'refs/heads/chat', g('-c', 'gpg.format=ssh', '-c', 'gpg.ssh.program=ssh-keygen', 'commit-tree', `-S${path.join(agent, 'keys', keyFile)}`, `${tip}^{tree}`, '-p', tip, '-m', 'Never deliver this\n\nTo: claude-zurich'), tip)
    const withheld = await run(agent, ['agent', 'inbox', '--json'], 'C')
    assert.equal(withheld.code, 0, withheld.err)
    assert.match(withheld.err, /ALARM.*operator.*signature/s)
    assert.deepEqual(JSON.parse(withheld.out), [])
    // Removal is for good: the record, then the forge's rights; the account comes back only as a new actor.
    assert.match(await ok(op, ['room', 'remove', 'claude-zurich']), /removed claude-zurich from .*, and its rights on the forge/)
    assert.deepEqual(await f.access.effective('fix'), {main: ['root'], chat: ['root'], signals: {operator: 'root'}})
    assert.match((await run(agent, ['agent', 'inbox'], 'C')).err, /claude-zurich was removed from room/)
    assert.match(await ok(op, ['room', 'invite', 'claude-zurich']), /claude-zurich joins as claude-zurich-2: /)
    assert.match((await run(op, ['room', 'invite', 'claude-zurich'])).err, /claude-zurich is invited or admitted in this room already/)
    // A second room in the space needs no credentials again; other ones are refused rather than taken.
    assert.match((await run(op, ['room', 'create', `${f.space}/next`, '--token-file', pins])).err, /is known here with the token in /)
    assert.match(await ok(op, ['room', 'create', `${f.space}/next`]), /created room .*\/ringi\/next/)
    assert.equal(f.keys.get('root')!.length, 1)
  })

  // This process as the root's machine, beside a fake forge whose repositories are local directories.
  const machine = async (t: TestContext) => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ringi-sdk-')))
    t.after(() => fs.rmSync(base, {recursive: true, force: true}))
    const served = path.join(base, 'forge')
    fs.mkdirSync(served)
    const f = await fake(t, served), home = path.join(base, 'home')
    const build = {version: 'test', resources: fileURLToPath(new URL('../../main/resources', import.meta.url))}, state = stateFsV5({root: home, build})
    wireHub({build, state, transports: {git: git4Transport(home, {signer: () => keysFile(home)})}, store: 'git', roomFiles, access: {forgejo: forgejoAccess}})
    const pins = path.join(base, 'known_hosts')
    fs.writeFileSync(pins, '[forge.test]:2222 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJKE+QBr08CsIXK0ahcMjAhI6ijaA1Jf8hGl0JyaoCG6\n')
    return {base, served, f, state, pins}
  }

  it('says which address to create again when a create stops after its room was made', async t => {
    const {f, state, pins} = await machine(t), write = state.write
    let failed = false
    state.write = (key, value) => {
      if (!failed && key.at(-1) === 'invitations') { failed = true; throw new Error('fixture invitation write failure') }
      return write(key, value)
    }
    const stopped = await Create.create(f.space, {invite: ['claude-zurich'], tokenFile: f.auth, hostKeyFile: pins}).then(() => '', (e: Error) => e.message)
    const address = /^fixture invitation write failure; run ringi room create (forgejo:\/\/\S+\/ringi\/room-[0-9a-f]{6}) again to finish it$/.exec(stopped)?.[1] ?? assert.fail(stopped)
    const done = await Create.create(address, {invite: ['claude-zurich']})
    assert.deepEqual(done.invites.map(i => i.actor), ['claude-zurich'])
    assert.equal(f.repos.size, 1, 'one repository on the forge')
  })

  it('writes nothing, here or on the forge, through a view of a room deleted and made again at its address', async t => {
    const {base, served, f, pins} = await machine(t), room = `${f.space}/fix`
    const old = (await Create.create(room, {invite: ['claude-zurich'], tokenFile: f.auth, hostKeyFile: pins})).R
    const registered = Rooms.doomed(room)
    await f.access.deleteServer('fix', Rooms.catalogue().providerId(registered.id, registered.reservation!.generation)!)
    fs.rmSync(path.join(served, 'fix.git'), {recursive: true})
    Rooms.erase(Rooms.doomed(room))
    const now = (await Create.create(room, {invite: ['claude-zurich']})).R
    assert.notDeepEqual(now.context, old.context)
    assert.equal(spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(base, 'k')]).status, 0)
    const key = fs.readFileSync(path.join(base, 'k.pub'), 'utf8')
    f.keys.get('claude-zurich')!.push(key.trim().split(' ').slice(0, 2).join(' '))
    const writes = f.writes.length, head = now.head
    await assert.rejects(Membership.admitInSpace(old, 'claude-zurich', key), /incarnation changed|of another room/)
    await assert.rejects(Membership.removeFromSpace(old, 'claude-zurich'), /incarnation changed|of another room|never invited/)
    assert.equal(f.writes.length, writes, 'nothing written on the forge')
    assert.equal(Rooms.roomNamed(room).head, head, 'nothing written in the room')
  })
  it('refuses server deletion without a saved local identity and gives manual host recovery guidance', async t => {
    const {f, state, pins} = await machine(t), address = `${f.space}/legacy`
    await Create.create(address, {tokenFile: f.auth, hostKeyFile: pins})
    const r = Rooms.doomed(address), before = [...f.writes]
    state.remove(['catalogue', 'rooms', r.id, 'provider'])
    await assert.rejects(deleteServerRoom(r), /no saved provider repository id; server deletion is refused; delete it on the host yourself/)
    assert.deepEqual(f.writes, before)
    assert.ok(f.repos.has('legacy'))
  })
})
