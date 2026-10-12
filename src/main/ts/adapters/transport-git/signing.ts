// GitSigningBridge: Signer signs the exact unsigned Git object. Tags append its SSH armor; commits fold it into
// gpgsig. Custody is injected; only legacy direct entrypoints retain their previous file-key signing default.

import {fail} from '../../lib/index.ts'
import type {Handle} from './remote/types.ts'
import {git, id, ident, isRemote} from './remote/git.ts'
import {identityKey, parseKey, rootKey, sign} from './remote/keys.ts'
import {command} from './remote/process.ts'
import {checkSignature} from './remote/signature.ts'

export const signBytes = (H: Handle, who: string, payload: Buffer | string, home: string): string => {
  if (!isRemote(H)) return ''
  if (!H.signing) {
    const file = sign(H, who, home)[0].slice(2)
    return command('ssh-keygen', ['-Y', 'sign', '-n', 'git', '-f', file], {input: payload})
  }
  const context = H.signing, key = context.resolve(id(H.name), id(who))
  const identity = context.signer.publicIdentity(key), publicKey = parseKey(identity.key)
  if (who === 'operator' && publicKey.line !== rootKey(H).line) fail('the local operator key does not match this hub\'s pinned root')
  const signature = context.signer.sign({key, payload: Buffer.isBuffer(payload) ? payload : Buffer.from(payload), namespace: 'git', interaction: 'forbidden', deadline: performance.now() + 30000})
  if (signature.format !== 'ssh' || signature.namespace !== 'git' || signature.fingerprint !== publicKey.fp) fail('the signer returned an incompatible signature identity or format')
  return Buffer.from(signature.bytes).toString('utf8')
}
// The legacy constructor path already asked Git to sign; only an injected provider uses the neutral byte bridge.
export const signCommit = (H: Handle, who: string, sha: string, home: string): string => {
  if (!H.signing || !isRemote(H)) return sha
  const raw = git(H, ['cat-file', 'commit', sha], {raw: true}), end = raw.indexOf('\n\n')
  if (end < 0) fail('malformed unsigned commit')
  const signature = signBytes(H, who, raw, home).trimEnd().replace(/\n/g, '\n ')
  const body = Buffer.concat([raw.subarray(0, end), Buffer.from(`\ngpgsig ${signature}\n\n`), raw.subarray(end + 2)])
  const signed = git(H, ['hash-object', '-t', 'commit', '-w', '--stdin'], {input: body}).trim()
  checkSignature(H, signed, who, identityKey(H, who, home))
  return signed
}

export const signedTag = (H: Handle, who: string, tag: string, target: string, home: string): string => {
  const tagger = git(H, ['var', 'GIT_COMMITTER_IDENT'], {env: ident(who)}).trim()
  const raw = `object ${target}\ntype commit\ntag ${tag}\ntagger ${tagger}\n\n`
  const signed = git(H, ['mktag'], {input: raw + signBytes(H, who, raw, home)}).trim()
  checkSignature(H, signed, who, identityKey(H, who, home), 'tag')
  return signed
}
