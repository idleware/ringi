import * as C from '../../../lib/index.ts'
import * as P from '../../../core/hub/protocol/index.ts'
import {git} from './git.ts'
import type {Handle, Raw} from './types.ts'

export const readCommits = (H: Handle, shas: string[]): Raw[] => {
  if (!shas.length) return []
  const out = git(H, ['cat-file', '--batch'], {input: Buffer.from(shas.join('\n') + '\n'), raw: true})
  let at = 0
  return shas.map(sha => {
    const nl = out.indexOf(0x0a, at)
    const [got, type, size] = out.subarray(at, nl).toString('utf8').split(' ')
    if (got !== sha || type !== 'commit') C.fail(`malformed commit ${sha.slice(0, 12)}`)
    const body = out.subarray(nl + 1, nl + 1 + Number(size))
    at = nl + 1 + Number(size) + 1
    const split = body.indexOf(Buffer.from('\n\n'))
    const hdr = body.subarray(0, split < 0 ? body.length : split).toString('utf8')
    const parents = [...hdr.matchAll(/^parent ([0-9a-f]+)$/gm)].map(m => m[1])
    const author = /^author (.*?) <[^>\n]*> \d+ [+-]\d{4}$/m.exec(hdr)?.[1] ?? ''
    const message = split < 0 ? Buffer.alloc(0) : body.subarray(split + 2)
    return {sha, parents, author, body: message, text: P.decodeText(message).text ?? ''}
  })
}
