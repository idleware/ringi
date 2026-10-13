// signature: commits and tags checked against the key of their principal; a branch checked to be linear.

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as C from '../../../lib/index.ts'
import * as P from '../../../core/hub/protocol/index.ts'
import {git, mkdir} from './git.ts'
import {signerLine} from './keys.ts'
import type {Commit, Handle, Key} from './types.ts'

export const verified = new Set<string>()

const signerFile = (H: Handle, text: string): string => {
  const dir = path.join(H.dir, 'ringi', 'verify')
  mkdir(dir)
  const file = path.join(dir, crypto.createHash('sha256').update(text).digest('hex') + '.allowed_signers')
  if (!fs.existsSync(file)) fs.writeFileSync(file, text, {flag: 'wx', mode: 0o600})
  else if (fs.readFileSync(file, 'utf8') !== text) C.fail('local signature verification cache was changed')
  return file
}

export const checkSignature = (H: Handle, sha: string, who: string, key: Key, kind: 'commit' | 'tag' = 'commit'): void => {
  const cache = `${kind}/${sha}/${who}/${key.fp}`
  if (verified.has(cache)) return
  const file = signerFile(H, signerLine(who, key))
  const r = git(H, ['-c', `gpg.ssh.allowedSignersFile=${file}`, '-c', 'gpg.ssh.revocationFile=' + os.devNull, `verify-${kind}`, sha], {ok: true})
  if (r.status !== 0) C.fail(`bad or missing signature at ${sha.slice(0, 12)}: not signed by the admitted key of ${who}`)
  const raw = git(H, ['cat-file', kind, sha], {raw: true})
  const split = raw.indexOf(Buffer.from('\n\n'))
  if (split < 0) C.fail(`malformed ${kind}`)
  const hdr = raw.subarray(0, split).toString('utf8')
  if (/^encoding (?!UTF-8$|utf-8$)/m.test(hdr)) C.fail('commit declares a non-UTF-8 message')
  const d = P.decodeText(raw.subarray(split + 2))
  if (d.invalid) C.fail(`${kind} message is ${d.invalid}`)
  verified.add(cache)
  if (verified.size > 4096) verified.delete(verified.values().next().value!)
}

export const chain = (H: Handle, head: string, base?: string): Commit[] => git(H, ['rev-list', '--parents', '--reverse', '--topo-order', head, ...(base ? [`^${base}`] : [])]).trim().split('\n').filter(Boolean).map(line => {
  const [sha, ...parents] = line.split(' ')
  return {sha, parents}
})

export const linear = (commits: Commit[], initial: string | null, check: (sha: string) => void): void => {
  let expect = initial
  for (const {sha, parents: ps} of commits) {
    if (ps.length > 1 || (ps[0] || null) !== expect) C.fail(`history is not linear at ${sha.slice(0, 12)}`)
    check(sha)
    expect = sha
  }
}
