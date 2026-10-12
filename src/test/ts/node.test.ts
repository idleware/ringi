// Node implementation tests: direct imports and source-level fault injection.
import {describe, it} from 'node:test'
import type {TestContext} from 'node:test'
import type {Session} from '../../main/ts/core/agents/sessions/index.ts'
import type {asJson} from '../../main/ts/core/hub/usecases/view.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {spawn, spawnSync} from 'node:child_process'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {locked} from '../../main/ts/adapters/fs/index.ts'
import {BASE, quote} from './cli.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(HERE, '../../../target/esm/cli.js')
const NODE = process.execPath
const until = async (ready: () => boolean) => {
  const end = Date.now() + 10000
  while (!ready() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20))
  assert.ok(ready(), 'the expected checkpoint was reached')
}
const world = (t: TestContext) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ringi-node-'))
  t.after(() => fs.rmSync(home, {recursive: true, force: true}))
  const ok = (args: string[], {as}: {as?: string} = {}) => {
    const r = spawnSync(NODE, [CLI, ...args], {encoding: 'utf8', env: {...BASE, RINGI_HOME: home, ...(as ? {RINGI_SESSION: as} : {})}})
    assert.equal(r.status, 0, `ringi ${args.join(' ')}: ${r.stderr}`)
    return r.stdout
  }
  function json(args: ['sessions', ...string[]]): Session[]
  function json(args: ['log', ...string[]]): ReturnType<typeof asJson>[]
  function json(args: string[]): unknown { return JSON.parse(ok([...args, '--json'])) }
  const lastId = (args: string[]): string => /(?:sent|proposed) ([0-9a-f]{12})/.exec(ok(args))?.[1] ?? assert.fail('CLI returned no message id')
  return {home, ok, json, lastId}
}

describe('Node implementation: main', () => {
  it('handles a closed stdout when called through its public export', t => {
    const w = world(t), status = path.join(w.home, 'status')
    const code = `const {main} = await import(${JSON.stringify(pathToFileURL(CLI).href)}); await main(['help'])`
    const r = spawnSync('sh', ['-c', `(${quote(NODE)} --input-type=module -e ${quote(code)}; printf '%s' "$?" > ${quote(status)}) | true`],
      {encoding: 'utf8', env: BASE})
    assert.equal(r.status, 0, r.stderr)
    assert.equal(fs.readFileSync(status, 'utf8'), '0', r.stderr)
    assert.doesNotMatch(r.stderr, /EPIPE|Unhandled/)
  })
})

describe('Node implementation: watcher dispatch', () => {
  it('honors stop during the last grant read before dispatch', async (t) => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    w.ok(['join', 'local', 'r', '--as', 'codex'], {as: 'C'})
    w.ok(['leave'], {as: 'C'})
    const p = w.lastId(['propose', '-m', 'one turn', '--decider', 'operator', '--budget', 'runs=1,run-seconds=10'])
    const g = /grant (\w+)/.exec(w.ok(['decide', p, 'approved', '-m', 'go']))![1]
    w.ok(['send', '--task', '--assign', 'codex', '--grant', g, '-m', 'work'])
    const ready = path.join(w.home, 'ready'), resume = path.join(w.home, 'resume'), marker = path.join(w.home, 'started')
    const wrapper = path.join(w.home, 'watch.mjs')
    // Pause after the plan is saved, while dispatch rereads its grant. Stop must still win before spawn.
    fs.writeFileSync(wrapper, `import fs from 'node:fs';
      const read = fs.readFileSync; let paused = false;
      fs.readFileSync = function(file, ...args) {
        const data = read.call(fs, file, ...args);
        if (!paused && String(file).endsWith('/codex.json') && String(file).includes('/readers/') && JSON.parse(data).watched) {
          paused = true; fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
          const end = Date.now() + 10000;
          while (!fs.existsSync(${JSON.stringify(resume)}) && Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        }
        return data;
      };
      const {main} = await import(${JSON.stringify(pathToFileURL(CLI).href)}); await main(process.argv.slice(2));`)
    const child = spawn(NODE, [wrapper, 'watch', 'r/codex', '--once', '--require-grant', '--exec', `touch '${marker}'`], {env: {...BASE, RINGI_HOME: w.home}, stdio: 'ignore'})
    const exit = new Promise(resolve => child.once('exit', resolve))
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL') })
    await until(() => fs.existsSync(ready))
    const session = w.json(['sessions']).find(s => s.product === 'watch')!
    w.ok(['stop'], {as: session.handle.slice(4)})
    fs.writeFileSync(resume, 'resume')
    assert.equal(await exit, 0)
    assert.equal(fs.existsSync(marker), false)
    const receipt = w.json(['log', '--all', '-n', '100']).find(m => m.kind === 'usage' && m.trailers.usage[0] === 'settle')!
    assert.equal(receipt.trailers.seconds[0], '0')
    assert.equal(receipt.trailers.exit[0], '125')
  })

})

describe('Node implementation: file locks', () => {
  it('serializes competing processes after recovering a dead owner', async (t) => {
    const w = world(t)
    const file = path.join(w.home, 'shared.lock'), count = path.join(w.home, 'count')
    fs.writeFileSync(file, '999999.dead')
    fs.writeFileSync(count, '0')
    const code = `import fs from 'node:fs';
      import {locked} from ${JSON.stringify(pathToFileURL(path.join(HERE, '../../../target/esm/adapters/fs/index.js')).href)};
      for (let i = 0; i < 10; i++) locked(${JSON.stringify(file)}, () => {
        const n = Number(fs.readFileSync(${JSON.stringify(count)}, 'utf8'));
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
        fs.writeFileSync(${JSON.stringify(count)}, String(n + 1));
      });`
    const children = Array.from({length: 4}, () => spawn(NODE, ['--input-type=module', '-e', code], {env: BASE, stdio: 'ignore', timeout: 10000}))
    t.after(() => children.forEach(child => { if (child.exitCode === null) child.kill('SIGKILL') }))
    const codes = await Promise.all(children.map(child => new Promise(resolve => child.once('exit', resolve))))
    assert.deepEqual(codes, [0, 0, 0, 0])
    assert.equal(fs.readFileSync(count, 'utf8'), '40')
    assert.equal(fs.existsSync(file), false)
    assert.equal(fs.existsSync(file + '.recover'), false)
  })

  it('preserves abandoned, live and unknown recovery gates', (t) => {
    const w = world(t)
    const file = path.join(w.home, 'shared.lock'), gate = file + '.recover'
    fs.writeFileSync(file, '999999.dead')
    for (const token of ['999998.dead', `${process.pid}.live`, '']) {
      fs.writeFileSync(gate, token)
      assert.throws(() => locked(file, () => assert.fail('entered a blocked lock'), 25), /abandoned|held/)
      assert.equal(fs.readFileSync(gate, 'utf8'), token)
      assert.equal(fs.readFileSync(file, 'utf8'), '999999.dead')
    }
  })

})
