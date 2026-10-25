// A room on a real Forgejo in docker, through the command line, over its own API and SSH: what the fakes cannot show,
// the server's rules as it enforces them on pushes.
import {describe, it} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {BASE, BIN} from '../ts/cli.ts'
import {ORG, dockerAvailable, server} from './server.ts'

const ring = (home: string, session?: string) => (...args: string[]) => {
  const r = spawnSync(BIN[0], [...BIN.slice(1), ...args], {encoding: 'utf8', timeout: 300_000,
    env: {...BASE, RINGI_HOME: home, ...(session ? {RINGI_SESSION: session} : {})}})
  return {code: r.status, out: r.stdout, err: r.stderr}
}
const ok = (r: {code: number | null, out: string, err: string}, what: string) => { assert.equal(r.code, 0, `${what}: ${r.err}`); return r.out }
// The files a joined machine keeps: its key for the account, and its copy of the room's repository.
const keyOf = (home: string, login: string) => path.join(home, 'keys', fs.readdirSync(path.join(home, 'keys'), {recursive: true}).map(String).find(f => f.endsWith(`/${login}`))!)
const storeOf = (home: string) => path.join(home, 'clones', fs.readdirSync(path.join(home, 'clones'))[0], 'store', '.git')

describe('a room on Forgejo in docker', {skip: !dockerAvailable() && 'docker is not available'}, () => {
  it('lives over the server\'s API and SSH, and the server keeps each actor to its own branch', async t => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ringi-it-forgejo-')))
    t.after(() => fs.rmSync(base, {recursive: true, force: true}))
    const s = await server(t, 'forgejo', base), room = `${s.space}/fix`
    s.user('alice')
    const op = ring(path.join(base, 'op')), agent = ring(path.join(base, 'agent'), 'A'), agentHome = path.join(base, 'agent')

    // The room is made there, private, and the invitee gets its line.
    const made = ok(op('room', 'create', room, '--invite', 'alice', '--token-file', s.tokenFile, '--host-key-file', s.hostKeyFile), 'room create')
    const invitation = /alice joins as alice: .*\n {2}ringi join (ringi:\S+)/.exec(made)![1]
    assert.equal((await s.api<{private: boolean}>('GET', `/repos/${ORG}/fix`)).body.private, true)

    // Over SSH the server lets the invitee read nothing yet: the join shows its key.
    const pending = agent('join', invitation)
    assert.equal(pending.code, 3, pending.err)
    const key = /ringi room admit alice '([^']+)'/.exec(pending.out)![1]
    assert.match(op('room', 'admit', 'alice', key).err, /not on alice's SSH keys/)
    await s.keyOn('alice', key)
    ok(op('room', 'admit', 'alice', key), 'room admit')
    assert.match(ok(agent('join', invitation), 'join'), /joined forgejo:\/\/localhost:\d+\/team\/fix as alice/)

    // Signed work both ways, verified on the other machine.
    ok(op('send', '--task', '--assign', 'alice', '-m', 'Fix it'), 'send')
    const task = (JSON.parse(ok(agent('agent', 'inbox', '--json'), 'inbox')) as Array<{id: string, kind: string, trust: string}>).find(m => m.kind === 'task')!
    assert.equal(task.trust, 'verified')
    ok(agent('agent', 'reply', task.id, '--state', 'completed', '-m', 'Done'), 'reply')
    assert.deepEqual((JSON.parse(ok(op('tasks', '--all', '--json'), 'tasks')) as Array<{state: string, by: string}>).map(x => [x.state, x.by]), [['completed', 'alice']])

    // What only the server can refuse: alice, with her own key, writes her own branch and nothing else.
    const mine = keyOf(agentHome, 'alice'), store = storeOf(agentHome)
    const tip = spawnSync('git', ['--git-dir', store, 'rev-parse', 'refs/heads/chat'], {encoding: 'utf8'}).stdout.trim()
    const signals = spawnSync('git', ['--git-dir', store, 'rev-parse', 'refs/heads/alice/signals'], {encoding: 'utf8'}).stdout.trim()
    assert.equal(s.push(store, mine, 'fix', `${signals}:refs/heads/alice/signals`).status, 0, 'alice reaches her own branch with her key')
    for (const [refspec, why] of [[`${tip}:refs/heads/main`, 'main'], [`${tip}:refs/heads/operator/signals`, 'the root\'s signals'],
      [`${tip}:refs/heads/bob/signals`, 'another actor\'s signals'], [`+${tip}~1:refs/heads/chat`, 'a rewritten chat'], [`${tip}:refs/tags/v1`, 'a tag']]) {
      const r = s.push(store, mine, 'fix', refspec)
      assert.notEqual(r.status, 0, `the server let alice push ${why}`)
      assert.match(r.err, /protected|not allowed|declined|rejected/i, `the server refused ${why} by its rules, not by its door: ${r.err}`)
    }

    // Removal takes the account's rights back on the server; the account returns only as a new actor.
    ok(op('room', 'remove', 'alice'), 'room remove')
    assert.equal((await s.api('GET', `/repos/${ORG}/fix/collaborators/alice`)).status, 404)
    assert.notEqual(s.push(store, mine, 'fix', `${tip}:refs/heads/alice/signals`).status, 0, 'a removed actor still pushes')
    assert.match(ok(op('room', 'invite', 'alice'), 'room invite'), /alice joins as alice-2: /)
  })
})
