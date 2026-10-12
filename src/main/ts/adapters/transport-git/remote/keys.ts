// keys: public keys as given and pinned, a signed hub's root and its signers, and which key signs for a principal.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import * as C from '../../../lib/index.ts'
import {config, id, isRemote, mkdir, rev} from './git.ts'
import {command} from './process.ts'
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

const keyPath = (H: Handle, who: string, home: string): string => path.join(home, 'keys', id(H.name), id(who))

const localKey = (H: Handle, who: string, home: string, create = false): Key & {file: string} => {
  const file = keyPath(H, who, home)
  if (!fs.existsSync(file)) {
    if (!create) C.fail(`no private key for ${who} on this machine; ${who === ROOT ? 'root keys are never obtained from a hub' : 'join here to generate one, then ask the root to admit its public key'}`)
    mkdir(path.dirname(file))
    command('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `${who}@ringi`, '-f', file])
  }
  // Derive from the private key instead of trusting a mutable .pub sidecar.
  const key = parseKey(command('ssh-keygen', ['-y', '-f', file]))
  return {...key, file}
}

export const identityKey = (H: Handle, who: string, home: string, create = false): Key => H.signing
  ? parseKey(H.signing.signer.publicIdentity(H.signing.resolve(id(H.name), id(who), create)).key)
  : localKey(H, who, home, create)

export const setupSigned = (H: Handle, home: string, url?: string): {root: string, allowedSigners: string} => {
  id(H.name)
  if (rev(H, 'refs/heads/main')) C.fail('setupSigned only initializes an empty hub; it cannot replace an existing trust anchor')
  const key = identityKey(H, ROOT, home, true)
  H.d.trust = 'signed'
  H.d.root = key.line
  config(H, 'gpg.format', 'ssh')
  config(H, 'gpg.ssh.program', 'ssh-keygen')
  if (url) {
    checkUrl(url)
    H.d.store.remote = url
  }
  return {root: key.line, allowedSigners: signerLine(ROOT, key)}
}

export const sign = (H: Handle, who: string, home: string): string[] => {
  if (!isRemote(H)) return []
  const key = localKey(H, who, home)
  if (who === ROOT && key.line !== rootKey(H).line) C.fail('the local operator key does not match this hub\'s pinned root')
  config(H, 'gpg.format', 'ssh')
  config(H, 'gpg.ssh.program', 'ssh-keygen')
  return [`-S${key.file}`]
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
