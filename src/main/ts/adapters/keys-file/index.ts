// keys-file: the existing headless SSH key custody behind Signer. Construction does no I/O; only an explicit
// resolve(create) makes a key. Public identity is derived from the private key, never from a mutable .pub sidecar.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {Fail} from '../../lib/index.ts'
import {guardWrite, mkdirIn} from '../fs/index.ts'
import type {KeyRef, PublicIdentity, SignRequest, SigningContext, SigningFault, SigningReason} from '../../core/signing/index.ts'

const refusal = (reason: SigningReason, message: string): SigningFault => Object.assign(new Fail(message), {reason})
const name = (value: string): string => {
  if (!value || value === '.' || value === '..' || /[/\\\0]/.test(value)) throw refusal('denied', 'invalid key owner')
  return value
}
const command = (args: string[], input: string | Buffer = '', timeout = 30000): string => {
  const r = spawnSync('ssh-keygen', args, {encoding: 'utf8', input, timeout, maxBuffer: 64 * 1024 * 1024,
    env: {...process.env, SSH_ASKPASS_REQUIRE: 'never'}})
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') throw refusal('timeout', 'key signing timed out')
  if (r.error || r.status !== 0) {
    const detail = String(r.stderr || r.error?.message || r.signal || 'failed').trim().split('\n').at(-1)
    throw refusal(/passphrase/i.test(detail || '') ? 'interaction-required' : 'unavailable', `ssh-keygen: ${detail}`)
  }
  return r.stdout
}
const identity = (file: string, timeout = 30000): PublicIdentity => {
  const [algorithm, bytes] = command(['-y', '-P', '', '-f', file], '', timeout).trim().split(/\s+/)
  return {key: `${algorithm} ${bytes}`, fingerprint: 'SHA256:' + crypto.createHash('sha256').update(Buffer.from(bytes, 'base64')).digest('base64').replace(/=+$/, '')}
}
const remaining = (r: SignRequest): number => {
  const ms = r.deadline - performance.now()
  if (!Number.isFinite(ms) || ms <= 0) throw refusal('timeout', 'key signing deadline expired')
  if (!r.namespace || /[\r\n\0]/.test(r.namespace)) throw refusal('denied', 'invalid signature namespace')
  return Math.max(1, Math.min(30000, Math.floor(ms)))
}
// Where a key reference keeps its key: the legacy `ringi-key:<hub>/<agent>`, a machine's key for an account realm
// (`ringi-key:realm/<id>/<account>`), a room's own key (`ringi-key:room/<id>/<label>`), or an explicit file the operator
// configured (`file:<absolute path>`, never made here). Anything else is refused, never guessed.
const located = (home: string, ref: string): {file: string, makes: boolean} => {
  const scoped = /^ringi-key:(realm|room)\/([0-9a-f]{16,64})\/([^/]+)$/.exec(ref)
  if (scoped) return {file: path.join(home, 'keys', scoped[1], scoped[2], name(scoped[3])), makes: true}
  const legacy = /^ringi-key:([^/]+)\/([^/]+)$/.exec(ref)
  if (legacy) return {file: path.join(home, 'keys', name(legacy[1]), name(legacy[2])), makes: true}
  if (ref.startsWith('file:') && path.isAbsolute(ref.slice('file:'.length))) return {file: ref.slice('file:'.length), makes: false}
  throw refusal('denied', `no key reference ringi reads: ${ref.split(':')[0]}:…`)
}
export const keysFile = (home: string): SigningContext => {
  const files = new Map<KeyRef, string>()
  const refs = new Map<string, KeyRef>()
  const keyFile = (key: KeyRef): string => files.get(key) ?? (() => { throw refusal('denied', 'key reference belongs to another signer') })()
  const custody = (hub: string, principal: string) => path.join(home, 'keys', name(hub), name(principal))
  // The key in `file`, made there first if asked and allowed; a reference to it this signer alone knows.
  const reference = (file: string, owner: string, create: boolean, makes: boolean): KeyRef => {
    if (!fs.existsSync(file)) {
      if (!create || !makes) throw refusal('unavailable', `no private key for ${owner} on this machine; ${owner === 'operator' ? 'root keys are never obtained from a hub' : 'join here to generate one, then ask the root to admit its public key'}`)
      mkdirIn(home, path.dirname(file))
      guardWrite(home, () => command(['-q', '-t', 'ed25519', '-N', '', '-C', `${owner}@ringi`, '-f', file]))
    }
    const ref = refs.get(file) ?? crypto.randomUUID() as KeyRef
    files.set(ref, file)
    refs.set(file, ref)
    return ref
  }
  return {
    custody,
    resolve: (hub, principal, create = false) => reference(custody(hub, principal), principal, create, true),
    custodyRef: ref => located(home, ref).file,
    resolveRef: (ref, create = false) => {
      const {file, makes} = located(home, ref)
      return reference(file, path.basename(file), create, makes)
    },
    signer: {
      publicIdentity: ref => identity(keyFile(ref)),
      sign: r => {
        const file = keyFile(r.key), publicKey = identity(file, remaining(r))
        const bytes = command(['-Y', 'sign', '-n', r.namespace, '-f', file], Buffer.from(r.payload), remaining(r))
        return {format: 'ssh', bytes: Buffer.from(bytes), fingerprint: publicKey.fingerprint, namespace: r.namespace}
      },
    },
  }
}
