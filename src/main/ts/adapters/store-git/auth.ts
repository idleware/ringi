// Transport credentials are local, injected and independent of commit signing. Resolve only for a remote command.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fail} from '../../lib/index.ts'
import {storeOf} from '../../core/hub/rooms/address.ts'
import {parseKey} from './remote/keys.ts'
import type {Handle} from './remote/types.ts'

export type SshIdentity = {type: 'file', path: string} | {type: 'agent', socket: string, publicKey: string}
export interface TransportAuth {resolve(authRef: string, address: string): SshIdentity}

const absolute = (value: string): string => typeof value === 'string' && path.isAbsolute(value) && !/[\r\n\0%]/.test(value) && !value.includes('${')
  ? value : fail('TransportAuth requires an absolute identity file or agent socket path')
const quote = (value: string): string => "'" + value.replace(/'/g, "'\\''") + "'"

const pins = (keys: string[] | undefined, host: string): string => {
  if (!keys?.length || keys.length > 64) return fail('SSH requires explicit hostKeys for its exact host and port')
  const matched: string[] = []
  for (const line of keys) {
    if (typeof line !== 'string' || line.length > 32768 || /[\r\n\0]/.test(line)) fail('expected one known_hosts line per host pin')
    const fields = line.trim().split(/\s+/)
    const names = fields[0].split(',')
    if (names.some(n => /[*?!|@]/.test(n))) fail('hostKeys must use exact host names, without patterns, hashes or markers')
    const key = parseKey(fields.slice(1).join(' '))
    if (names.some(n => n.toLowerCase() === host.toLowerCase())) matched.push(`${host} ${key.line}`)
  }
  return matched.length ? matched.join('\n') + '\n' : fail('hostKeys do not pin this SSH host and port')
}

const sshHost = (locator: string): string => {
  let url: URL
  try {url = new URL(locator)} catch {return fail('malformed SSH address')}
  if (!url.hostname || url.password || url.search || url.hash) fail('expected a credentialless SSH address')
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  return url.port && url.port !== '22' ? `[${hostname}]:${url.port}` : hostname
}

const request = (H: Handle): {address: string, ref: string, known: string} | null => {
  const address = H.endpoint?.store.remote ?? H.d.contract?.remote
  if (!address) return fail('remote operation has no explicit address')
  const {locator} = storeOf(address)
  const ref = H.endpoint?.authRef
  if (!locator.startsWith('ssh://')) {
    if (ref) fail('TransportAuth binding is supported only for SSH addresses')
    return null
  }
  const known = pins(H.endpoint ? H.endpoint.hostKeys : H.d.access?.hostKeys, sshHost(locator))
  if (typeof ref !== 'string' || !ref.trim() || /[\r\n\0]/.test(ref)) return fail('SSH requires an explicit endpoint authRef binding')
  return {address, ref, known}
}

const selected = (identity: SshIdentity, temporary: string): {identityFile: string, agent: string} => {
  if (identity.type === 'file') {
    const identityFile = absolute(identity.path)
    if (!fs.statSync(identityFile, {throwIfNoEntry: false})?.isFile()) fail('TransportAuth identity is not a file')
    return {identityFile, agent: 'none'}
  }
  if (identity.type === 'agent') {
    const agent = absolute(identity.socket), identityFile = path.join(temporary, 'identity.pub')
    fs.writeFileSync(identityFile, parseKey(identity.publicKey).line + '\n', {mode: 0o600})
    return {identityFile, agent}
  }
  return fail('TransportAuth returned an unsupported SSH identity')
}

const environment = (identity: SshIdentity, temporary: string, known: string): NodeJS.ProcessEnv => {
  const knownFile = path.join(temporary, 'known_hosts')
  fs.writeFileSync(knownFile, known, {mode: 0o600})
  const {identityFile, agent} = selected(identity, temporary)
  const args = ['ssh', '-F', os.devNull, '-i', identityFile, '-o', `IdentityAgent=${JSON.stringify(agent)}`,
    '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'UpdateHostKeys=no', '-o', `UserKnownHostsFile=${JSON.stringify(knownFile)}`, '-o', `GlobalKnownHostsFile=${os.devNull}`,
    '-o', 'PreferredAuthentications=publickey', '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no']
  return {GIT_SSH_COMMAND: args.map(quote).join(' '), GIT_SSH_VARIANT: 'ssh', SSH_AUTH_SOCK: identity.type === 'agent' ? agent : undefined}
}

// The callback runs while temporary PUBLIC identity/known_hosts files exist; errors and timeouts also remove them.
export const withTransportAuth = <T>(H: Handle, run: (env: NodeJS.ProcessEnv) => T): T => {
  const r = request(H)
  if (!r) return run({})
  const identity = H.auth?.resolve(r.ref, r.address) ?? fail('SSH requires an injected TransportAuth provider')
  const parent = path.join(H.dir, 'ringi')
  fs.mkdirSync(parent, {recursive: true, mode: 0o700})
  const temporary = fs.mkdtempSync(path.join(parent, 'ssh-'))
  try {return run(environment(identity, temporary, r.known))}
  finally {fs.rmSync(temporary, {recursive: true, force: true})}
}
