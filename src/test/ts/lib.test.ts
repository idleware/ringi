// lib: helpers that know nothing of ringi.
import {describe, it} from 'node:test'
import assert from 'node:assert/strict'
import {strictJson} from '../../main/ts/lib/index.ts'

describe('lib', () => {
  it('reads JSON strictly: every value, no duplicate field at any depth, nothing after it', () => {
    for (const text of ['{}', '[]', ' [ true , false , null , -1.5e3 , 0 ] ', '{"a":[1,{"b":"x\\"y"}],"c":{},"d":[]}', '"s"'])
      assert.deepEqual(strictJson(text), JSON.parse(text), text)
    for (const text of ['{"a":1,"a":2}', '{"a":{"b":1,"b":2}}', '[{"a":1,"a":1}]', '[1,]', '{"a":1,}', '{"a" 1}', '[1 2]', '{} x', '"open', '{1:2}', 'nul', ''])
      assert.throws(() => strictJson(text, 'test'), /test: malformed or duplicate JSON field/, text)
  })
})
