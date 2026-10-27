// lib: helpers that know nothing of ringi.
import {describe, it} from 'node:test'
import assert from 'node:assert/strict'
import {sameObject, shown, strictJson, withoutCredentials} from '../../main/ts/lib/index.ts'

describe('lib', () => {
  it('reads JSON strictly: every value, no duplicate field at any depth, nothing after it', () => {
    for (const text of ['{}', '[]', ' [ true , false , null , -1.5e3 , 0 ] ', '{"a":[1,{"b":"x\\"y"}],"c":{},"d":[]}', '"s"'])
      assert.deepEqual(strictJson(text), JSON.parse(text), text)
    for (const text of ['{"a":1,"a":2}', '{"a":{"b":1,"b":2}}', '[{"a":1,"a":1}]', '[1,]', '{"a":1,}', '{"a" 1}', '[1 2]', '{} x', '"open', '{1:2}', 'nul', ''])
      assert.throws(() => strictJson(text, 'test'), /test: malformed or duplicate JSON field/, text)
    // Nested deeper than any record ringi reads: refused, not a stack overflow.
    assert.deepEqual(strictJson('['.repeat(64) + ']'.repeat(64)), JSON.parse('['.repeat(64) + ']'.repeat(64)))
    for (const n of [65, 5000]) assert.throws(() => strictJson('['.repeat(n) + ']'.repeat(n), 'deep'), /deep: malformed/)
  })

  it('compares directory objects without the device number a mount gives', () => {
    assert.ok(sameObject('16777234:98765:1761470000123456789', '16777230:98765:1761470000123456789'))
    assert.ok(!sameObject('16777234:98765:1761470000123456789', '16777234:98766:1761470000123456789'))
    assert.ok(!sameObject('16777234:98765:1761470000123456789', '16777234:98765:1761470000123456780'))
  })

  it('shows control characters on a terminal instead of obeying them', () => {
    assert.equal(shown('a\x1b]52;c;eA==\x07\r\nb\tc\u0085'), 'a\\x1b]52;c;eA==\\x07\\x0d\nb\tc\\x85')
  })

  it('shows a typed address without credentials, keeping an SSH login', () => {
    assert.equal(withoutCredentials('git+https://claude:t0k3n@forge.example/ringi/fix.git'), 'git+https://forge.example/ringi/fix.git')
    assert.equal(withoutCredentials('git+https://t0k3n@forge.example/ringi/fix.git'), 'git+https://forge.example/ringi/fix.git')
    for (const kept of ['git+ssh://git@forge.example:2222/ringi/fix.git', 'ssh://git@forge.example/ringi/fix.git', 'git+file:///srv/ringi/fix.git'])
      assert.equal(withoutCredentials(kept), kept)
    assert.equal(withoutCredentials('git+ssh://git:t0k3n@forge.example/ringi/fix.git'), 'git+ssh://forge.example/ringi/fix.git')
  })
})
