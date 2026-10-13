// keys: public keys as given and pinned, a signed hub's root and its signers, and which key signs for a principal.

import crypto from 'node:crypto'
import fs from 'node:fs'
import * as C from '../../../lib/index.ts'
import {id, rev} from './git.ts'
import type {Handle, Key} from './types.ts'
import {ROOT} from './types.ts'

export const parseKey = (value: unknown): Key => {
  const text = String(value || '').trim()
  const m = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) ([A-Za-z0-9+/]+={0,2})(?: [^\r\n]*)?$/.exec(text) ?? C.fail('expected one SSH public key (or a file containing it)')
  if (m[2].length > 16384) C.fail('expected one SSH public key (or a file containing it)')
  const data = Buffer.from(m[2], 'base64')
  if (data.length < 8 || data.readUInt32BE(0) > data.length - 4 || data.subarray(4, 4 + data.readUInt32BE(0)).toString() !== m[1]) C.fail('malformed SSH public key')
  const line = `${m[1]} ${m[2]}`
  return {line, fp: 'SHA256:' + crypto.createHash('sha256').update(data).digest('base64').replace(/=+$/, '')}
}

export const keyInput = (value: string): Key => parseKey(fs.existsSync(value) && fs.statSync(value).isFile() ? fs.readFileSync(value, 'utf8') : value)

export const rootKey = (H: Handle): Key => parseKey(H.d.root || C.fail(`hub ${H.name} has no out-of-band root pin; use hub add --root <public-key|file>`))

export const signerLine = (who: string, key: Key): string => `${who} namespaces="git" ${key.line}\n`

export const signingContext = (H: Pick<Handle, 'name' | 'signing'>) => H.signing ?? C.fail(`hub ${H.name}: signed writes require an injected Signer`)

export const identityKey = (H: Handle, who: string, create = false): Key => {
  const context = signingContext(H)
  return parseKey(context.signer.publicIdentity(context.resolve(id(H.name), id(who), create)).key)
}

export const setupSigned = (H: Handle, url?: string): {root: string, allowedSigners: string} => {
  id(H.name)
  if (rev(H, 'refs/heads/main')) C.fail('setupSigned only initializes an empty hub; it cannot replace an existing trust anchor')
  const key = identityKey(H, ROOT, true)
  H.d.trust = 'signed'
  H.d.root = key.line
  if (url) {
    checkUrl(url)
    H.d.store.remote = url
  }
  return {root: key.line, allowedSigners: signerLine(ROOT, key)}
}

export const rootRoster = (H: Handle): string => signerLine(ROOT, rootKey(H))

const supportedUrl = (url: string): boolean => {
  const malformed = /[\r\n\0]/.test(url) || url.startsWith('-')
  const cleartext = /^http:\/\//i.test(url)
  const transport = /^(?:file|https|ssh):\/\/|^(?:[^\s/@:]+@)?[^\s/:]+:[^\s]+$|^\//.test(url)
  return !malformed && !cleartext && transport
}
export const checkUrl = (url: string): void => {
  if (typeof url !== 'string' || !supportedUrl(url)) C.fail('use a file://, https:// or ssh Git URL; cleartext HTTP and custom transport helpers are refused')
}
