// Exact signal facts: bounded UTF-8, unique fields and full causal revisions.
import * as C from '../../../lib/index.ts'
import * as P from '../../../core/hub/protocol/index.ts'
import type {Raw} from './types.ts'
import {SHA} from './types.ts'
export type Facts = Map<string, string>
const fieldMap = (text: string): Facts => {
  const fields = new Map<string, string>()
  for (const line of text.trimEnd().split('\n')) {
    const m = /^([A-Z][A-Za-z]*): (.+)$/.exec(line) ?? C.fail('stream record must contain only facts')
    if (fields.has(m[1])) C.fail(`duplicate stream fact ${m[1]}`)
    fields.set(m[1], m[2])
  }
  return fields
}
const checkFields = (fields: Facts): void => {
  const allowed = ['Room', 'Control', 'Target', 'Signal']
  if ([...fields.keys()].some(k => !allowed.includes(k))) C.fail('unknown stream fact')
  for (const field of ['Room', 'Control', 'Target']) if (!SHA.test(fields.get(field) ?? '')) C.fail(`${field} must name a full revision`)
}
const checkSignal = (fields: Facts): void => {
  if (fields.size !== 4 || !/^[a-z][a-z0-9._-]*$/.test(fields.get('Signal') ?? '')) C.fail('a signal has exactly Room, Control, Target and a logical Signal')
}
export const streamFacts = (c: Raw): Facts => {
  const d = P.decodeText(c.body)
  if (d.invalid || Buffer.byteLength(c.body) > 4096) C.fail('stream facts have invalid encoding or size')
  const fields = fieldMap(d.text!)
  checkFields(fields)
  checkSignal(fields)
  return fields
}
