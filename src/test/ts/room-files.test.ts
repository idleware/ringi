import {describe, it} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {TestContext} from 'node:test'
import {roomFiles} from '../../main/ts/adapters/location-fs/index.ts'

const fixture = (t: TestContext) => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ringi-room-files-')))
  t.after(() => fs.rmSync(base, {recursive: true, force: true}))
  const home = path.join(base, 'home')
  fs.mkdirSync(home)
  return {base, home}
}

describe('repository directory files port', () => {
  it('canonicalizes aliases of one object and distinguishes a different directory', t => {
    const {base} = fixture(t), first = path.join(base, 'first'), second = path.join(base, 'second'), alias = path.join(base, 'alias')
    fs.mkdirSync(first); fs.mkdirSync(second); fs.symlinkSync(first, alias)
    const expected = roomFiles.canonical(first)!
    assert.deepEqual(roomFiles.canonical(alias), expected)
    assert.notEqual(roomFiles.canonical(second)!.identity, expected.identity)
    fs.unlinkSync(alias); fs.symlinkSync(second, alias)
    assert.notEqual(roomFiles.canonical(alias)!.identity, expected.identity, 'caller can refuse a previously bound alias')
  })

  it('creates one exclusive leaf and preserves existing directories and their contents', t => {
    const {base, home} = fixture(t), target = path.join(base, 'room')
    const made = roomFiles.createLeaf(target, home)
    assert.equal(made.path, target)
    roomFiles.check(made)
    assert.equal(fs.statSync(target).mode & 0o777, 0o700)
    fs.writeFileSync(path.join(target, 'foreign'), 'kept')
    assert.throws(() => roomFiles.createLeaf(target, home))
    assert.equal(fs.readFileSync(path.join(target, 'foreign'), 'utf8'), 'kept')
    assert.deepEqual(roomFiles.canonical(target), made)
  })

  it('refuses missing parents, relative paths and protected targets without creating intermediate paths', t => {
    const {base, home} = fixture(t)
    assert.throws(() => roomFiles.createLeaf(path.join(base, 'missing', 'room'), home), /parent must already exist/)
    assert.equal(fs.existsSync(path.join(base, 'missing')), false)
    for (const target of ['relative', path.join(base, 'a', '..', 'room') + '/.', home, base, '/']) {
      assert.throws(() => roomFiles.createLeaf(target, home), /absolute|components|home|ancestor|root/, target)
    }
    assert.deepEqual(fs.readdirSync(base), ['home'])
  })

  it('reports missing or replaced selected objects instead of silently following a replacement', t => {
    const {base} = fixture(t), target = path.join(base, 'room')
    fs.mkdirSync(target)
    const pinned = roomFiles.canonical(target)!
    fs.renameSync(target, path.join(base, 'old'))
    assert.throws(() => roomFiles.check(pinned), /disappeared|identity/)
    fs.mkdirSync(target)
    assert.throws(() => roomFiles.check(pinned), /identity/)
    assert.notEqual(roomFiles.canonical(target)!.identity, pinned.identity)
  })

  it('returns null only for missing directories and refuses files or malformed paths', t => {
    const {base} = fixture(t), file = path.join(base, 'file')
    fs.writeFileSync(file, 'x')
    assert.equal(roomFiles.canonical(path.join(base, 'missing')), null)
    assert.throws(() => roomFiles.canonical(file), /not a directory/)
    assert.throws(() => roomFiles.canonical(file + '/child'))
    assert.throws(() => roomFiles.canonical(base + '/../other'), /components/)
  })

  it('honestly refuses unsupported contained purge and retains repository bytes', t => {
    const {base, home} = fixture(t), target = path.join(base, 'room')
    const directory = roomFiles.createLeaf(target, home)
    fs.writeFileSync(path.join(target, 'evidence'), 'kept')
    assert.throws(() => roomFiles.purge({reservation: 'own', address: 'local://r', genesis: 'g', directory}, home), /purge is unsupported/)
    assert.equal(fs.readFileSync(path.join(target, 'evidence'), 'utf8'), 'kept')
    roomFiles.check(directory)
  })
})
