// heartbeat-facts: the text of a heartbeat object, its fields checked.

import * as C from '../../../lib/index.ts'
import * as P from '../../../core/hub/protocol/index.ts'
import {SHA} from './types.ts'

export const heartbeatBody = (text: string): string => {
  if (Buffer.byteLength(text) > 16384) C.fail('heartbeat body exceeds 16 KiB')
  const decoded = P.decodeText(Buffer.from(text))
  if (decoded.invalid) C.fail(`heartbeat body is ${decoded.invalid}`)
  const lines = decoded.text!.trimEnd().split('\n')
  const fields = heartbeatFields(lines)
  const genesis = fields.get('Room') ?? C.fail('heartbeat must name its full room genesis')
  if (!SHA.test(genesis)) C.fail('heartbeat must name its full room genesis')
  if (!/^(working|waiting|gone)$/.test(fields.get('State') ?? '')) C.fail('invalid heartbeat State')
  if (!/^(yes|no|unknown)$/.test(fields.get('Alive') ?? '')) C.fail('invalid heartbeat Alive')
  const next = Number(fields.get('Next'))
  if (!Number.isFinite(next) || next <= 0) C.fail('heartbeat Next must be positive seconds')
  return genesis
}

const heartbeatFields = (lines: string[]): Map<string, string> => {
  const fields = new Map<string, string>()
  for (const line of lines) {
    const m = /^([A-Z][A-Za-z]*): (.+)$/.exec(line) ?? C.fail('heartbeat body must contain only facts as trailers')
    if (fields.has(m[1])) C.fail(`duplicate heartbeat field ${m[1]}`)
    fields.set(m[1], m[2])
  }
  return fields
}
