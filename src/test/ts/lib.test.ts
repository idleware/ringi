// lib: helpers that know nothing of ringi.
import {describe, it} from 'node:test'
import assert from 'node:assert/strict'
import {strictJson, withoutCredentials} from '../../main/ts/lib/index.ts'

describe('lib', () => {
  it('reads JSON strictly: every value, no duplicate field at any depth, nothing after it', () => {
    for (const text of ['{}', '[]', ' [ true , false , null , -1.5e3 , 0 ] ', '{"a":[1,{"b":"x\\"y"}],"c":{},"d":[]}', '"s"'])
      assert.deepEqual(strictJson(text), JSON.parse(text), text)
    for (const text of ['{"a":1,"a":2}', '{"a":{"b":1,"b":2}}', '[{"a":1,"a":1}]', '[1,]', '{"a":1,}', '{"a" 1}', '[1 2]', '{} x', '"open', '{1:2}', 'nul', ''])
      assert.throws(() => strictJson(text, 'test'), /test: malformed or duplicate JSON field/, text)
  })

  it('shows a typed address without credentials, keeping an SSH login', () => {
    assert.equal(withoutCredentials('git+https://claude:t0k3n@forge.example/ringi/fix.git'), 'git+https://forge.example/ringi/fix.git')
    assert.equal(withoutCredentials('git+https://t0k3n@forge.example/ringi/fix.git'), 'git+https://forge.example/ringi/fix.git')
    for (const kept of ['git+ssh://git@forge.example:2222/ringi/fix.git', 'ssh://git@forge.example/ringi/fix.git', 'git+file:///srv/ringi/fix.git'])
      assert.equal(withoutCredentials(kept), kept)
    assert.equal(withoutCredentials('git+ssh://git:t0k3n@forge.example/ringi/fix.git'), 'git+ssh://forge.example/ringi/fix.git')
  })
})
