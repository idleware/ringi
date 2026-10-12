// run: git as a child process, with the hub's timeout, its isolated environment and the sandbox's one message; and
// splitting what it prints.

import {spawnSync} from 'node:child_process'
import type {SpawnSyncReturns} from 'node:child_process'
import {fail} from '../../lib/index.ts'
import {cannotWrite, SANDBOX} from '../fs/index.ts'
import * as Remote from './remote.ts'

export const ZERO = '0'.repeat(40)
export const ident = (id: string) => ({GIT_AUTHOR_NAME: id, GIT_AUTHOR_EMAIL: `${id}@ringi`, GIT_COMMITTER_NAME: id, GIT_COMMITTER_EMAIL: `${id}@ringi`})
// `where`: the directory to name when a sandbox refuses a write (the ringi home).
export type GitOpt = {input?: string | Buffer, env?: Record<string, string>, where?: string}

export const runGit = (args: string[], o: GitOpt = {}): string => {
  const r = spawnSync('git', args, {input: o.input, encoding: 'utf8', env: Remote.gitEnv(o.env), maxBuffer: 1 << 30, timeout: Remote.gitTimeout()})
  return check(args, r, o.where).stdout
}
export const runGitOk = (args: string[], o: GitOpt = {}): SpawnSyncReturns<string> => {
  const r = spawnSync('git', args, {input: o.input, encoding: 'utf8', env: Remote.gitEnv(o.env), maxBuffer: 1 << 30, timeout: Remote.gitTimeout()})
  Remote.checkGitTimeout(r.error)
  return r
}
export const runGitRaw = (args: string[], where?: string, input?: Buffer): Buffer => {
  const r = spawnSync('git', args, {input, encoding: 'buffer', env: Remote.gitEnv(), maxBuffer: 1 << 30, timeout: Remote.gitTimeout()})
  return check(args, r, where).stdout
}
function check<T extends string | Buffer>(args: string[], r: SpawnSyncReturns<T>, where = 'the hub store'): SpawnSyncReturns<T> {
  Remote.checkGitTimeout(r.error)
  if (r.error) throw r.error
  if (r.status !== 0) {
    const err = String(r.stderr ?? '').trim()
    if (SANDBOX.test(err)) cannotWrite(where, err.split('\n').at(-1)!)
    fail(`git ${args.find(a => !a.startsWith('-') && !a.includes('/')) ?? ''}: ${err.split('\n').at(-1)}`)
  }
  return r
}
export const splitBuf = (b: Buffer, sep: number): Buffer[] => {
  const parts: Buffer[] = []
  let at = 0
  for (let i = b.indexOf(sep); i >= 0; i = b.indexOf(sep, at)) {
    parts.push(b.subarray(at, i))
    at = i + 1
  }
  parts.push(b.subarray(at))
  return parts
}
// Objects of `git cat-file --batch`, read whole by their size, so no byte inside one can split it.
export const frames = (raw: Buffer, shas: string[]): Map<string, {type: string, body: Buffer}> => {
  const out = new Map<string, {type: string, body: Buffer}>()
  let at = 0
  for (const sha of shas) {
    const nl = raw.indexOf(0x0a, at)
    const [got, type, size] = raw.subarray(at, nl).toString('utf8').split(' ')
    if (got === sha) out.set(sha, {type, body: raw.subarray(nl + 1, nl + 1 + Number(size))})
    at = nl + 1 + Number(size) + 1
  }
  return out
}
