// GitSigningBridge: Signer signs the exact unsigned Git object. Tags append its SSH armor; commits fold it into
// gpgsig. All signing and public identity come from the injected Signer; custody stays outside the transport.

import {fail} from '../../lib/index.ts'
import type {Handle} from './remote/types.ts'
import {git, isRemote} from './remote/git.ts'
import {identityKey, localSigningKey, parseKey, rootKey, signingContext} from './remote/keys.ts'
import {checkSignature} from './remote/signature.ts'

export const signBytes = (H: Handle, who: string, payload: Buffer | string): string => {
  if (!isRemote(H)) return ''
  const context = signingContext(H), key = localSigningKey(H, who)
  const identity = context.signer.publicIdentity(key), publicKey = parseKey(identity.key)
  if (who === 'operator' && publicKey.line !== rootKey(H).line) fail('the local operator key does not match this hub\'s pinned root')
  const signature = context.signer.sign({key, payload: Buffer.isBuffer(payload) ? payload : Buffer.from(payload), namespace: 'git', interaction: 'forbidden', deadline: performance.now() + 30000})
  if (signature.format !== 'ssh' || signature.namespace !== 'git' || signature.fingerprint !== publicKey.fp) fail('the signer returned an incompatible signature identity or format')
  return Buffer.from(signature.bytes).toString('utf8')
}
export const signCommit = (H: Handle, who: string, sha: string): string => {
  if (!isRemote(H)) return sha
  const raw = git(H, ['cat-file', 'commit', sha], {raw: true}), end = raw.indexOf('\n\n')
  if (end < 0) fail('malformed unsigned commit')
  const signature = signBytes(H, who, raw).trimEnd().replace(/\n/g, '\n ')
  const body = Buffer.concat([raw.subarray(0, end), Buffer.from(`\ngpgsig ${signature}\n\n`), raw.subarray(end + 2)])
  const signed = git(H, ['hash-object', '-t', 'commit', '-w', '--stdin'], {input: body}).trim()
  checkSignature(H, signed, who, identityKey(H, who))
  return signed
}
