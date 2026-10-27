// Node implementation tests: direct imports and source-level fault injection.
import {describe, it} from 'node:test'
import type {TestContext} from 'node:test'
import type {asJson} from '../../main/ts/core/hub/usecases/view.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {spawn, spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {locked} from '../../main/ts/adapters/fs/index.ts'
import {BASE, quote} from './cli.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(HERE, '../../../target/esm/cli.js')
const NODE = process.execPath
const world = (t: TestContext) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ringi-node-'))
  t.after(() => fs.rmSync(home, {recursive: true, force: true}))
  const ok = (args: string[], {as}: {as?: string} = {}) => {
    const r = spawnSync(NODE, [CLI, ...args], {encoding: 'utf8', env: {...BASE, RINGI_HOME: home, ...(as ? {RINGI_SESSION: as} : {})}})
    assert.equal(r.status, 0, `ringi ${args.join(' ')}: ${r.stderr}`)
    return r.stdout
  }
  function json(args: ['log', ...string[]]): ReturnType<typeof asJson>[]
  function json(args: string[]): unknown { return JSON.parse(ok([...args, '--json'])) }
  const lastId = (args: string[]): string => /(?:sent|proposed) ([0-9a-f]{12})/.exec(ok(args))?.[1] ?? assert.fail('CLI returned no message id')
  return {home, ok, json, lastId}
}

describe('Node implementation: directory identity', () => {
  it('keeps rooms when a restart renumbers the file system, and still refuses another directory at the path', t => {
    const w = world(t)
    w.ok(['room', 'create', 'r'])
    w.ok(['join', 'r', '--as', 'codex'], {as: 'C'})
    w.ok(['send', '--to', 'codex', '-m', 'before'])
    // As if the room was made while the volume had another device number (macOS gives one at each mount): every
    // pinned identity keeps its inode and birth time, and an allocation is filed under the identity it was made with.
    const renumber = (s: string) => s.replace(/("identity":\s*")(\d+):/g, (_, head: string, dev: string) => `${head}${Number(dev) + 4}:`)
    for (const f of fs.readdirSync(w.home, {recursive: true}).map(String).filter(f => f.endsWith('.json'))) {
      const file = path.join(w.home, f), text = fs.readFileSync(file, 'utf8')
      if (!text.includes('"identity"')) continue
      fs.writeFileSync(file, renumber(text))
      if (path.basename(path.dirname(file)) !== 'room-allocations') continue
      const source = JSON.parse(renumber(text)).source.identity as string
      fs.renameSync(file, path.join(path.dirname(file), createHash('sha256').update(source).digest('hex') + '.json'))
    }
    assert.match(w.ok(['agent', 'inbox'], {as: 'C'}), /before/)
    w.ok(['send', '--to', 'codex', '-m', 'after'])
    // A copy at the room's path is another object: refused, whatever its device.
    const repo = path.join(w.home, 'rooms', 'r'), aside = `${repo}.aside`
    fs.renameSync(repo, aside)
    fs.cpSync(aside, repo, {recursive: true})
    const copy = spawnSync(NODE, [CLI, 'where'], {encoding: 'utf8', env: {...BASE, RINGI_HOME: w.home}})
    assert.notEqual(copy.status, 0)
    assert.match(copy.stderr, /changed/)
    fs.rmSync(repo, {recursive: true, force: true})
    fs.renameSync(aside, repo)
    assert.match(w.ok(['room', 'delete', 'r', '--yes']), /deleted room local:\/\/r/)
  })
})

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
