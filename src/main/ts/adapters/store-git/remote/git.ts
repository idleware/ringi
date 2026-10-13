// git: the isolated git invocation the signed transport uses for every read, write and signature check.

import type {SpawnSyncReturns} from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import * as C from '../../../lib/index.ts'
import * as FS from '../../fs/index.ts'
import * as P from '../../../core/hub/protocol/index.ts'
import {storeOf} from '../../../core/hub/rooms/address.ts'
import {withVerification} from './cache.ts'
import {BASE, command} from './process.ts'
import type {CommandOpt, Handle} from './types.ts'
import {ACCEPT, TRACK} from './types.ts'

export const reason = (e: unknown): string => e instanceof Error ? e.message : String(e)

export const mkdir = (d: string) => fs.mkdirSync(d, {recursive: true, mode: 0o700})

export const id = (s: string): string => P.ID_RE.test(s) ? s : C.fail(`bad agent or hub id ${s}`)

export const zero = (H: Handle): string => '0'.repeat(git(H, ['rev-parse', '--show-object-format']).trim() === 'sha256' ? 64 : 40)

export const ident = (who: string): NodeJS.ProcessEnv => ({GIT_AUTHOR_NAME: who, GIT_AUTHOR_EMAIL: `${who}@ringi`, GIT_COMMITTER_NAME: who, GIT_COMMITTER_EMAIL: `${who}@ringi`})

// Use the same isolated Git invocation for signatures and transport, even if the CLI wrapper's env differs.
export function git(H: Handle, args: string[], opt: CommandOpt & {ok: true}): SpawnSyncReturns<string>

export function git(H: Handle, args: string[], opt: CommandOpt & {raw: true}): Buffer

export function git(H: Handle, args: string[], opt?: CommandOpt): string

export function git(H: Handle, args: string[], opt?: CommandOpt): string | Buffer | SpawnSyncReturns<string> {
  return command('git', ['--git-dir', H.dir, ...BASE, ...args], opt)
}

export const config = (H: Handle, key: string, value?: string): string => value === undefined
  ? String(git(H, ['config', '--get', key], {ok: true}).stdout || '').trim()
  : git(H, ['config', key, String(value)])

export const rev = (H: Handle, ref: string): string | null => {
  const r = git(H, ['rev-parse', '-q', '--verify', `${ref}^{commit}`], {ok: true})
  return r.status === 0 ? r.stdout.trim() : null
}

export const object = (H: Handle, ref: string): string | null => {
  const r = git(H, ['rev-parse', '-q', '--verify', ref], {ok: true})
  return r.status === 0 ? r.stdout.trim() : null
}

export const ancestor = (H: Handle, a: string, b: string): boolean => !!a && !!b && git(H, ['merge-base', '--is-ancestor', a, b], {ok: true}).status === 0

export const isRemote = (H: Handle): boolean => {
  if (H.d.trust !== 'signed' && H.d.trust !== 'asserted') C.fail(`unsupported hub trust ${String(H.d.trust)}`)
  return H.d.trust === 'signed'
}

export const origin = (H: Handle): string | undefined => {
  const address = H.endpoint ? H.endpoint.store.remote : H.d.contract?.remote
  if (!address) return undefined
  const {type, locator} = storeOf(address)
  return type === 'git' ? locator : C.fail(`git cannot open a ${type} address`)
}

export const suffix = (ref: string): string => ref.replace(/^refs\/heads\//, '')

export const accepted = (ref: string): string => ACCEPT + suffix(ref)

export const tracking = (ref: string): string => TRACK + suffix(ref)

// Transport and home state use the same owner-aware lock.
export const locked = <T>(H: Handle, fn: () => T): T => {
  const file = path.join(H.dir, 'ringi', 'transport.lock')
  mkdir(path.dirname(file))
  return FS.locked(file, () => withVerification(H, fn))
}

export const refs = (H: Handle, prefix: string): Map<string, string> => new Map(git(H, ['for-each-ref', '--format=%(refname) %(objectname)', prefix]).trim().split('\n').filter(Boolean).map(s => s.split(' ') as [string, string]))

// The local accepted transport refs survive reader resets and retain evidence of remote rewrites/deletions.
export const promote = (H: Handle, ref: string, sha: string): void => {
  const acc = rev(H, accepted(ref))
  const cur = rev(H, ref)
  if (acc && !ancestor(H, acc, sha)) C.fail(`${suffix(ref)} was rewritten or rolled back from ${acc.slice(0, 12)} to ${sha.slice(0, 12)}`)
  if (cur && cur !== sha && !ancestor(H, cur, sha) && !ancestor(H, sha, cur)) C.fail(`${suffix(ref)} diverges from the local accepted history`)
  if (!cur || (cur !== sha && ancestor(H, cur, sha))) git(H, ['update-ref', ref, sha, cur || zero(H)])
  git(H, ['update-ref', accepted(ref), sha, acc || zero(H)])
}
