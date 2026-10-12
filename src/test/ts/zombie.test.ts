// Process-group settlement: zombies cannot execute; living, stopped and unobservable members still hold the turn.

import {describe, it} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import childProcess from 'node:child_process'
import {syncBuiltinESMExports} from 'node:module'
import {groupRunning, procMember, psMember} from '../../main/ts/adapters/host-posix/group-state.ts'
import {groupAlive} from '../../main/ts/adapters/host-posix/groups.ts'
import {hostPosix} from '../../main/ts/adapters/host-posix/index.ts'

describe('process-group settlement', () => {
  it('recognizes only zombie members, including command names with spaces and parentheses', () => {
    assert.deepEqual(procMember('42 (a tricky ) name) Z 1 42 0 0'), {group: 42, state: 'Z'})
    assert.deepEqual(psMember(' 42 Z+ '), {group: 42, state: 'Z'})
    const zombie = {group: 42, state: 'Z'}
    assert.equal(groupRunning(42, [zombie, {group: 7, state: 'R'}]), false)
    for (const state of ['R', 'S', 'D', 'T', 't', 'I', 'X']) {
      assert.equal(groupRunning(42, [zombie, {group: 42, state}]), true, state)
    }
    assert.equal(groupRunning(42, []), null)
    assert.equal(groupRunning(42, [zombie, null]), null)
    assert.equal(groupRunning(42, [null, {group: 42, state: 'S'}]), true)
    for (const raw of ['', '42 bad Z 1 42', '42 (bad) ZZ 1 42', '42 (bad) Z 1', '42 (bad) Z 1 -2']) {
      assert.equal(procMember(raw), null, raw)
    }
    for (const raw of ['', 'Z 42', '42', '42 Z extra', '-42 Z']) assert.equal(psMember(raw), null, raw)
  })

  it('keeps an existing group alive when membership probes fail or are incomplete', t => {
    const kill = t.mock.method(process, 'kill', () => true)
    const read = t.mock.method(fs, 'readdirSync', () => { throw new Error('unavailable') })
    const ps = t.mock.method(childProcess, 'spawnSync', () => ({status: 1, stdout: '', stderr: ''}))
    syncBuiltinESMExports()
    try {
      assert.equal(groupAlive(42), true)
      assert.deepEqual(ps.mock.calls[0].arguments.slice(0, 2), ['ps', ['-A', '-o', 'pgid=,stat=']])
      assert.equal(ps.mock.calls[0].arguments[2]!.timeout, 1000)
      ps.mock.mockImplementation(() => ({status: 0, stdout: '42 Z\nbad row\n', stderr: ''}))
      assert.equal(groupAlive(42), true)
      ps.mock.mockImplementation(() => ({status: 0, stdout: '42 Z\n7 S\n', stderr: ''}))
      assert.equal(groupAlive(42), false)
      ps.mock.mockImplementation(() => ({status: 0, stdout: '7 S\n', stderr: ''}))
      assert.equal(groupAlive(42), true, 'a missing row does not override a group that still exists')
      kill.mock.mockImplementation(() => { throw Object.assign(new Error('denied'), {code: 'EPERM'}) })
      assert.equal(groupAlive(42), true)
      const calls = ps.mock.calls.length
      kill.mock.mockImplementation(() => { throw Object.assign(new Error('gone'), {code: 'ESRCH'}) })
      assert.equal(groupAlive(42), false)
      assert.equal(ps.mock.calls.length, calls, 'a vanished group needs no membership probe')
    } finally {
      kill.mock.restore(); read.mock.restore(); ps.mock.restore(); syncBuiltinESMExports()
    }
  })

  it('keeps a detached turn open while its living descendant runs', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ringi-group-'))
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}))
    const marker = path.join(dir, 'members'), host = hostPosix()
    const handle = host.start({file: 'sh', args: ['-c', 'sleep 0.4 & echo "$$ $!" > "$RINGI_GROUP_MARKER"; exit 0'],
      env: {...process.env, RINGI_GROUP_MARKER: marker}})
    t.after(() => host.stop(handle))
    for (let i = 0; i < 100 && !fs.existsSync(marker); i++) await new Promise(resolve => setTimeout(resolve, 10))
    const [group] = fs.readFileSync(marker, 'utf8').trim().split(/\s+/).map(Number)
    assert.equal(groupAlive(group), true)
    assert.equal(await host.awaitQuiescence(handle, host.clock.monotonic() + 20), null)
    const result = await host.awaitQuiescence(handle, host.clock.monotonic() + 3000)
    assert.ok(result, 'the descendant finishes normally, including when PID 1 retains its zombie')
    assert.equal(result.code, 0)
    assert.equal(result.timedOut, false)
    assert.equal(groupAlive(group), false)
  })

  it('settles a genuine orphan zombie while kill(-pgid, 0) still succeeds', {skip: process.platform !== 'linux'}, t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ringi-zombie-'))
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}))
    const host = new URL('../../main/ts/adapters/host-posix/index.ts', import.meta.url).href
    const groups = new URL('../../main/ts/adapters/host-posix/groups.ts', import.meta.url).href
    const marker = path.join(dir, 'members')
    const code = `
      import fs from 'node:fs';
      import assert from 'node:assert/strict';
      import {hostPosix} from ${JSON.stringify(host)};
      import {groupAlive} from ${JSON.stringify(groups)};
      const host = hostPosix();
      const handle = host.start({shell: 'sleep 30 & echo "$$ $!" > "$RINGI_ZOMBIE_MARKER"; exit 0', timeout: null,
        env: {...process.env, RINGI_ZOMBIE_MARKER: ${JSON.stringify(marker)}}});
      let group;
      try {
        const result = await host.awaitQuiescence(handle, host.clock.monotonic() + 3000);
        const [pgid, pid] = fs.readFileSync(${JSON.stringify(marker)}, 'utf8').trim().split(/\\s+/).map(Number);
        group = pgid;
        let stat;
        try { stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8'); } catch (e) {
          if (e.code !== 'ENOENT') throw e;
          assert.ok(result, 'a reaped group must settle');
          console.log('SKIP: PID 1 reaped the orphan before it could be observed');
          process.exit(0);
        }
        const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\\s+/);
        assert.equal(fields[0], 'Z', stat);
        assert.equal(Number(fields[1]), 1, 'the zombie must be orphaned to PID 1');
        assert.equal(Number(fields[2]), pgid);
        assert.ok(result, 'an orphan zombie must not hold settlement past the observation deadline');
        assert.equal(result.code, 0);
        assert.equal(result.timedOut, false);
        process.kill(-pgid, 0);
        assert.equal(groupAlive(pgid), false);
        console.log('ORPHAN_ZOMBIE: pid=' + pid + ' pgid=' + pgid + ' state=Z ppid=1; settled with group still present');
      } finally {
        host.stop(handle);
        if (group) try { process.kill(-group, 'SIGKILL'); } catch {}
      }
      process.exit(0);
    `
    const result = childProcess.spawnSync(process.execPath, ['--input-type=module', '-e', code],
      {encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL'})
    assert.equal(result.error, undefined, result.stderr)
    assert.equal(result.status, 0, result.stderr)
    if (result.stdout.startsWith('SKIP:')) t.skip(result.stdout.trim())
    else { assert.match(result.stdout, /ORPHAN_ZOMBIE:/); t.diagnostic(result.stdout.trim()) }
  })
})
