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
import {forgejoAccess} from '../../main/ts/adapters/access-forgejo/index.ts'
import {BASE, BIN} from './cli.ts'

type Rule = {rule_name: string, enable_push: boolean, enable_push_whitelist: boolean, push_whitelist_usernames: string[], push_whitelist_deploy_keys: boolean}
type Repo = {name: string, private: boolean, rules: Rule[], collaborators: Map<string, string>, tags: Array<{name_pattern: string, whitelist_usernames: string[]}>}

// A Forgejo that knows one organisation, one token and the calls the adapter makes; it records every write.
const fake = async (t: TestContext, served?: string) => {
  const repos = new Map<string, Repo>(), writes: string[] = [], keys = new Map<string, string[]>([['root', []], ['claude-zurich', []], ['codex-amsterdam', []]])
  let admin = true, keepDeleted = false
  const body = (req: http.IncomingMessage): Promise<Record<string, unknown>> => new Promise(done => {
    let s = ''
    req.on('data', c => { s += c })
    req.on('end', () => done(s ? JSON.parse(s) : {}))
  })
  const server = http.createServer(async (req, res) => {
    const send = (status: number, value?: unknown) => { res.writeHead(status, {'Content-Type': 'application/json'}); res.end(value === undefined ? '' : JSON.stringify(value)) }
    if (req.headers.authorization !== 'token s3cret') return send(401, {message: 'unauthorized'})
    const url = decodeURIComponent(new URL(req.url!, 'http://x').pathname.replace('/api/v1', ''))
    const b = req.method === 'GET' ? {} : await body(req)
    if (req.method !== 'GET') writes.push(`${req.method} ${url}`)
    if (url === '/version') return send(200, {version: '13.0.0'})
    if (url === '/user') return send(200, {login: 'root'})
    if (url === '/user/keys') { if (req.method === 'POST') keys.get('root')!.push(String(b.key)); return send(req.method === 'POST' ? 201 : 200, keys.get('root')!.map(key => ({key}))) }
    const user = /^\/users\/([^/]+)\/keys$/.exec(url)
    if (user) return keys.has(user[1]) ? send(200, keys.get(user[1])!.map(key => ({key}))) : send(404, {})
    const enrol = /^\/admin\/users\/([^/]+)\/keys$/.exec(url)
    if (enrol) { if (!admin) return send(403, {message: 'forbidden'}); keys.get(enrol[1])!.push(String(b.key)); return send(201, {}) }
    const sshUrl = (name: string) => served ? `file://${path.join(served, `${name}.git`)}` : `ssh://git@forge.test:2222/ringi/${name}.git`
    if (url === '/orgs/ringi/repos' && req.method === 'POST') {
      const r: Repo = {name: String(b.name), private: !!b.private, rules: [], collaborators: new Map(), tags: []}
      repos.set(r.name, r)
      if (served) spawnSync('git', ['init', '-q', '--bare', '-b', 'main', path.join(served, `${r.name}.git`)])
      return send(201, {ssh_url: sshUrl(r.name)})
    }
    const m = /^\/repos\/ringi\/([^/]+)(\/.*)?$/.exec(url)
    const r = m && repos.get(m[1])
    if (!m) return send(404, {})
    if (!r) return send(404, {})
    const rest = m[2] ?? ''
    if (rest === '' && req.method === 'GET') return send(200, {ssh_url: sshUrl(r.name), private: r.private})
    if (rest === '' && req.method === 'DELETE') { if (!keepDeleted) repos.delete(r.name); return send(204) }
    if (rest === '/branch_protections' && req.method === 'GET') return send(200, r.rules)
    if (rest === '/branch_protections' && req.method === 'POST') { r.rules.push(b as unknown as Rule); return send(201, b) }
    const rule = /^\/branch_protections\/(.+)$/.exec(rest)
    if (rule && req.method === 'PATCH') { Object.assign(r.rules.find(x => x.rule_name === rule[1])!, b); return send(200, {}) }
    if (rule && req.method === 'DELETE') { r.rules = r.rules.filter(x => x.rule_name !== rule[1]); return send(204) }
    if (rest === '/tag_protections' && req.method === 'GET') return send(200, r.tags)
    if (rest === '/tag_protections' && req.method === 'POST') { r.tags.push(b as unknown as Repo['tags'][number]); return send(201, b) }
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
  return {repos, writes, keys, auth, space: `forgejo+http://127.0.0.1:${port}/ringi`, noAdmin: () => { admin = false }, keepDeleted: () => { keepDeleted = true },
    access: forgejoAccess(`http://127.0.0.1:${port}/ringi`, auth)}
}

describe('access: forgejo', () => {
  it('makes a private room repository that only the root may push, its own streams too, and asking again changes nothing', async t => {
    const f = await fake(t)
    assert.deepEqual(await f.access.inspect(), {version: '13.0.0', principal: 'root', can: {actorBranches: true, privateRepos: true, deleteServer: true}})
    assert.deepEqual(await f.access.ensureRoom('fix'), {address: 'git+ssh://git@forge.test:2222/ringi/fix.git'})
    const repo = f.repos.get('fix')!
    assert.equal(repo.private, true)
    assert.deepEqual(repo.rules.map(r => [r.rule_name, r.enable_push, r.enable_push_whitelist, r.push_whitelist_usernames, r.push_whitelist_deploy_keys]),
      [['main', true, true, ['root'], false], ['chat', true, true, ['root'], false], ['operator/signals', true, true, ['root'], false],
        ['operator/telemetry', true, true, ['root'], false], ['**', false, true, [], false]])
    assert.deepEqual(repo.tags, [{name_pattern: '*', whitelist_usernames: []}])
    const before = f.writes.filter(w => !w.startsWith('PATCH')).length
    await f.access.ensureRoom('fix')
    assert.equal(f.writes.filter(w => !w.startsWith('PATCH')).length, before, 'nothing is made twice')
    assert.deepEqual(await f.access.effective('fix'), {main: ['root'], chat: ['root'], streams: {operator: 'root'}})
  })

  it('gives an actor the room, chat and its own streams through its account, and takes them back', async t => {
    const f = await fake(t)
    await f.access.ensureRoom('fix')
    await f.access.grant('fix', 'claude', 'claude-zurich')
    await f.access.grant('fix', 'codex', 'codex-amsterdam')
    await f.access.grant('fix', 'claude', 'claude-zurich')
    const both = {main: ['root'], chat: ['root', 'claude-zurich', 'codex-amsterdam'], streams: {operator: 'root', claude: 'claude-zurich', codex: 'codex-amsterdam'}}
    assert.deepEqual(await f.access.effective('fix'), both)
    assert.deepEqual([...f.repos.get('fix')!.collaborators], [['claude-zurich', 'write'], ['codex-amsterdam', 'write']])
    // A revocation names the account the actor writes through, or takes nothing back.
    await assert.rejects(f.access.revoke('fix', 'claude', 'codex-amsterdam'), /codex-amsterdam writes codex's streams in ringi\/fix, not claude's; nothing is revoked/)
    await assert.rejects(f.access.revoke('fix', 'claude', 'someone'), /claude writes ringi\/fix through claude-zurich, not someone; nothing is revoked/)
    await assert.rejects(f.access.revoke('fix', 'operator', 'root'), /the operator's streams are the root's/)
    // An account listed on another actor's stream, however loose that rule, is that actor's too: nothing is taken back.
    const theirs = f.repos.get('fix')!.rules.find(r => r.rule_name === 'codex/signals')!, writes = f.writes.length
    Object.assign(theirs, {push_whitelist_usernames: ['codex-amsterdam', 'claude-zurich'], push_whitelist_teams: ['other-team']})
    await assert.rejects(f.access.revoke('fix', 'claude', 'claude-zurich'), /claude-zurich writes codex's streams in ringi\/fix, not claude's; nothing is revoked/)
    assert.equal(f.writes.length, writes, 'a refused revocation writes nothing')
    Object.assign(theirs, {push_whitelist_usernames: ['codex-amsterdam'], push_whitelist_teams: []})
    assert.deepEqual(await f.access.effective('fix'), both)
    const after = {main: ['root'], chat: ['root', 'codex-amsterdam'], streams: {operator: 'root', codex: 'codex-amsterdam'}}
    await f.access.revoke('fix', 'claude', 'claude-zurich')
    await f.access.revoke('fix', 'claude', 'claude-zurich')
    assert.deepEqual(await f.access.effective('fix'), after)
    // A revocation left half done, one stream rule gone and the rest still there, is finished by asking again.
    await f.access.grant('fix', 'claude', 'claude-zurich')
    const rules = f.repos.get('fix')!.rules
    rules.splice(rules.findIndex(r => r.rule_name === 'claude/signals'), 1)
    await assert.rejects(f.access.effective('fix'), /claude's streams do not let one same account push/)
    // What is left must name only this account, and let no more than it names, or nothing is taken back.
    const left = rules.find(r => r.rule_name === 'claude/telemetry')!
    left.push_whitelist_usernames = ['someone-else']
    await assert.rejects(f.access.revoke('fix', 'claude', 'claude-zurich'), /claude writes ringi\/fix through someone-else, not claude-zurich; nothing is revoked/)
    left.enable_push_whitelist = false
    await assert.rejects(f.access.revoke('fix', 'claude', 'claude-zurich'), /claude\/telemetry in ringi\/fix lets more than the accounts it names; nothing is revoked/)
    assert.equal(rules.includes(left), true, 'a refused revocation drops no rule')
    Object.assign(left, {push_whitelist_usernames: ['claude-zurich'], enable_push_whitelist: true})
    await f.access.revoke('fix', 'claude', 'claude-zurich')
    assert.deepEqual(await f.access.effective('fix'), after)
    assert.deepEqual([...f.repos.get('fix')!.collaborators.keys()], ['codex-amsterdam'])
    // An actor whose two streams disagree is a policy the forge does not keep as ringi wants: refused, not reported.
    f.repos.get('fix')!.rules.find(r => r.rule_name === 'codex/telemetry')!.push_whitelist_usernames = ['someone-else']
    await assert.rejects(f.access.effective('fix'), /codex's streams do not let one same account push/)
    await f.access.deleteServer('fix')
    assert.equal(f.repos.has('fix'), false)
  })

  it('puts the root\'s key on the token\'s own account once', async t => {
    const f = await fake(t)
    for (let i = 0; i < 2; i++) await f.access.ownKey('ssh-ed25519 AAAARoot operator@ringi')
    assert.deepEqual(f.keys.get('root'), ['ssh-ed25519 AAAARoot'])
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
    await assert.rejects(f.access.grant('fix', 'codex', 'claude-zurich'), /already writes claude's streams/)
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
    await widen(() => repo.tags[0].whitelist_usernames.push('claude-zurich'), () => repo.tags[0].whitelist_usernames.pop(), /tags are not closed/)
    const mine = repo.rules.find(r => r.rule_name === 'claude/signals')!
    await widen(() => { mine.enable_push_whitelist = false }, () => { mine.enable_push_whitelist = true }, /rule claude\/signals lets every writer/)
    const stream = (name: string, who: string) => ({rule_name: name, enable_push: true, enable_push_whitelist: true, push_whitelist_usernames: [who], push_whitelist_deploy_keys: false})
    await widen(() => repo.rules.push(stream('*/signals', 'x'), stream('*/telemetry', 'x')), () => { repo.rules.pop(); repo.rules.pop() }, /rule \*\/signals/)
    await widen(() => repo.rules.push(stream('zoe/telemetry', 'someone')), () => repo.rules.pop(), /zoe's streams do not let one same account push/)
    await widen(() => repo.rules.push(stream('zoe/signals', 'claude-zurich'), stream('zoe/telemetry', 'claude-zurich')), () => { repo.rules.pop(); repo.rules.pop() },
      /claude-zurich pushes the streams of claude and zoe/)
    await widen(() => repo.rules.push(stream('zoe/signals', 'root'), stream('zoe/telemetry', 'root')), () => { repo.rules.pop(); repo.rules.pop() },
      /root pushes the streams of operator and zoe/)
  })

  it('makes rooms only in private repositories, and says so when a deletion did not take', async t => {
    const f = await fake(t)
    await f.access.ensureRoom('fix')
    f.repos.get('fix')!.private = false
    await assert.rejects(f.access.ensureRoom('fix'), /exists on the forge and is public/)
    f.keepDeleted()
    await assert.rejects(f.access.deleteServer('fix'), /still on the forge after deleting it/)
  })

  it('refuses a token file others can read, and a space that is not one organisation over https', async t => {
    const f = await fake(t)
    fs.chmodSync(f.auth, 0o644)
    await assert.rejects(f.access.inspect(), /readable by others; chmod 600/)
    assert.throws(() => forgejoAccess('http://forge.example/ringi', f.auth), /reached over https/)
    assert.throws(() => forgejoAccess('https://forge.example/ringi/team', f.auth), /one organisation/)
    for (const space of ['https://user:pass@forge.example/ringi', 'https://forge.example/ringi?x=1', 'https://forge.example/ringi#x', 'ftp://localhost/ringi'])
      assert.throws(() => forgejoAccess(space, f.auth), /no credentials, query or fragment|reached over https/)
  })
})

describe('rooms on a forge, through the command line', () => {
  it('makes the room there, invites an agent, and gives its account the room once the root admits its key', async t => {
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
    const op = path.join(base, 'op'), agent = path.join(base, 'agent')
    assert.equal(spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(base, 'host')]).status, 0)
    const pins = path.join(base, 'known_hosts'), pin = `[forge.test]:2222 ${fs.readFileSync(path.join(base, 'host.pub'), 'utf8').trim().split(' ').slice(0, 2).join(' ')}`
    fs.writeFileSync(pins, `# the forge\n${pin}\n`)
    const unpinned = await run(op, ['hub', 'create', 'team', '--signed', '--forge', f.space, '--auth-file', f.auth])
    assert.match(unpinned.err, /--forge needs --host-key-file/)
    const manual = await run(op, ['hub', 'create', 'team', '--signed', '--url', 'git+ssh://git@forge.test:2222/ringi/main.git'])
    assert.match(manual.err, /an SSH address needs its host's pinned keys .* --url takes git\+https:\/\/ or git\+file:\/\//)
    const made = await run(op, ['hub', 'create', 'team', '--signed', '--forge', f.space, '--auth-file', f.auth, '--host-key-file', pins])
    assert.equal(made.code, 0, made.err)
    assert.match(made.out, /Its rooms are made in forgejo\+http:\/\/127\.0\.0\.1:\d+\/ringi, as root/)
    assert.equal(f.keys.get('root')!.length, 1, 'the root key is on the operator\'s account')
    const room = await run(op, ['room', 'create', 'fix', '--hub', 'team'])
    assert.equal(room.code, 0, room.err)
    const invitation = /ringi join (ringi:\S+) --as <agent>/.exec(room.out)![1]
    assert.equal(f.repos.get('fix')!.private, true)
    // Over SSH the forge lets nobody read the room before the root admits them: the agent is shown its key, and keeps
    // nothing of the room. Here ssh is a stand-in that answers as a forge does to an unknown key.
    const bin = path.join(base, 'bin'), offer = JSON.parse(Buffer.from(invitation.slice('ringi:'.length), 'base64url').toString())
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'ssh'), '#!/bin/sh\necho "git@forge.test: Permission denied (publickey)." >&2\nexit 255\n', {mode: 0o755})
    const overSsh = {...offer, address: 'git+ssh://git@forge.test:2222/ringi/fix.git', hostKeys: [pin]}
    const denied = await run(agent, ['join', 'ringi:' + Buffer.from(JSON.stringify(overSsh)).toString('base64url'), '--as', 'claude'], 'C', {PATH: `${bin}:${process.env.PATH}`})
    assert.equal(denied.code, 3, denied.err)
    const key = /ringi room admit claude '([^']+)'/.exec(denied.out)![1]
    assert.deepEqual(fs.readdirSync(agent, {recursive: true}).filter(p => String(p).includes('rooms/')), [], 'a denied join keeps no room')
    const first = await run(agent, ['join', invitation, '--as', 'claude'], 'C')
    assert.equal(first.code, 3, first.err)
    assert.equal(/ringi room admit claude '([^']+)'/.exec(first.out)![1], key, 'the key it was shown is the one it joins with')
    const admitted = await run(op, ['room', 'admit', 'claude', key, '--as', 'claude-zurich', '--room', 'fix'])
    assert.equal(admitted.code, 0, admitted.err)
    assert.deepEqual(await f.access.effective('fix'), {main: ['root'], chat: ['root', 'claude-zurich'], streams: {operator: 'root', claude: 'claude-zurich'}})
    assert.equal(f.keys.get('claude-zurich')!.length, 1, 'the agent\'s key is on its account')
    const joined = await run(agent, ['join', invitation, '--as', 'claude'], 'C')
    assert.equal(joined.code, 0, joined.err)
    assert.match(joined.out, /joined fix as claude/)
    // The fake enforces no rules on a push: what both sides really push is held against the matrix instead.
    assert.equal((await run(op, ['send', '--task', '--assign', 'claude', '-m', 'Fix it'])).code, 0)
    const task = (JSON.parse((await run(agent, ['agent', 'inbox', '--json'], 'C')).out) as Array<{id: string, kind: string}>).find(m => m.kind === 'task')!
    const done = await run(agent, ['agent', 'reply', task.id, '--state', 'completed', '-m', 'Done'], 'C')
    assert.equal(done.code, 0, done.err)
    assert.equal((await run(agent, ['pulse', '--once'], 'C')).code, 0)
    const refs = spawnSync('git', ['--git-dir', path.join(served, 'fix.git'), 'for-each-ref', '--format=%(refname)'], {encoding: 'utf8'}).stdout.trim().split('\n')
    assert.deepEqual(refs.filter(r => !r.startsWith('refs/heads/')), [], 'only branches are pushed')
    const {streams} = await f.access.effective('fix'), streamOf = (b: string) => /^([^/]+)\/(signals|telemetry)$/.exec(b)?.[1]
    for (const b of refs.map(r => r.slice('refs/heads/'.length))) assert.ok(['main', 'chat'].includes(b) || streams[streamOf(b) ?? ''], `${b} is a branch the matrix lets someone push`)
    for (const b of ['operator/signals', 'claude/signals']) assert.ok(refs.includes(`refs/heads/${b}`), `${b} was pushed`)
  })
})
