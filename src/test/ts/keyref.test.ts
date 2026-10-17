// A room endpoint's key reference (E8): one key for the actor's signatures and its SSH, kept where the reference
// says: the legacy per-hub key, a machine's key for an account realm, a room's own key, or a file the operator named.
import {it} from 'node:test'
import type {TestContext} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {keysFile} from '../../main/ts/adapters/keys-file/index.ts'

const home = (t: TestContext) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ringi-keyref-'))
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}))
  return dir
}
const realm = 'ab'.repeat(16)

it('finds each reference where it says, makes one only when asked, and never makes an operator file', t => {
  const h = home(t), k = keysFile(h)
  assert.equal(k.custodyRef!('ringi-key:team/claude'), k.custody!('team', 'claude'), 'the legacy reference is the per-hub key')
  assert.equal(k.custodyRef!(`ringi-key:realm/${realm}/alice`), path.join(h, 'keys', 'realm', realm, 'alice'))
  assert.equal(k.custodyRef!(`ringi-key:room/${realm}/claude`), path.join(h, 'keys', 'room', realm, 'claude'))
  assert.throws(() => k.resolveRef!(`ringi-key:realm/${realm}/alice`), /no private key for alice/)
  const made = k.resolveRef!(`ringi-key:realm/${realm}/alice`, true)
  assert.match(k.signer.publicIdentity(made).key, /^ssh-ed25519 /)
  assert.equal(k.resolveRef!(`ringi-key:realm/${realm}/alice`), made, 'the same key again')
  const own = path.join(h, 'own')
  assert.throws(() => k.resolveRef!(`file:${own}`, true), /no private key/, 'an operator file is never made here')
  assert.equal(spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', own]).status, 0)
  assert.match(k.signer.publicIdentity(k.resolveRef!(`file:${own}`)).key, /^ssh-ed25519 /)
})

it('refuses what it does not read: other schemes, relative files, bad ids and paths out of the key owner', t => {
  const k = keysFile(home(t))
  for (const ref of ['agent:/tmp/sock#key', 'file:relative/key', 'ringi-key:realm/xyz/alice', `ringi-key:realm/${realm}/..`, 'ringi-key:a/b/c'])
    assert.throws(() => k.custodyRef!(ref), /no key reference ringi reads|invalid key owner/, ref)
})
