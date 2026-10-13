// process: running git and ssh-keygen isolated from the user's configuration, with a timeout.

import type {SpawnSyncReturns} from 'node:child_process'
import {spawnSync} from 'node:child_process'
import os from 'node:os'
import * as C from '../../../lib/index.ts'
import type {CommandOpt} from './types.ts'

export const ENV = {GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', LC_ALL: 'C'}

export const BASE = ['-c', 'core.hooksPath=' + os.devNull, '-c', 'gpg.format=ssh', '-c', 'gpg.ssh.program=ssh-keygen',
  '-c', 'color.ui=false', '-c', 'log.showSignature=false', '-c', 'core.quotePath=false',
  '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always', '-c', 'protocol.ssh.allow=always',
  '-c', 'protocol.https.allow=always', '-c', 'http.followRedirects=false']

export const gitEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GIT_CONFIG_|GIT_DIR$|GIT_WORK_TREE$|GIT_INDEX_FILE$|GIT_OBJECT_DIRECTORY$|GIT_ALTERNATE_OBJECT_DIRECTORIES$|GIT_REPLACE_REF_BASE$)/.test(k))),
  ...ENV, ...extra,
})

export const gitTimeout = (): number => {
  const ms = Number(process.env.RINGI_GIT_TIMEOUT_MS ?? 30000)
  if (!Number.isSafeInteger(ms) || ms < 1) C.fail('RINGI_GIT_TIMEOUT_MS must be a positive integer (milliseconds)')
  return ms
}

export const checkGitTimeout = (error?: NodeJS.ErrnoException): void => {
  if (error?.code === 'ETIMEDOUT') throw Object.assign(new C.Fail('git timed out; increase RINGI_GIT_TIMEOUT_MS (positive integer milliseconds)'), {code: 'ETIMEDOUT'})
}

export function command(cmd: string, args: string[], opt: CommandOpt & {ok: true}): SpawnSyncReturns<string>

export function command(cmd: string, args: string[], opt: CommandOpt & {raw: true}): Buffer

export function command(cmd: string, args: string[], opt?: CommandOpt): string

export function command(cmd: string, args: string[], opt: CommandOpt = {}): string | Buffer | SpawnSyncReturns<string | Buffer> {
  const r = spawnSync(cmd, args, {
    input: opt.input, encoding: opt.raw ? 'buffer' : 'utf8', env: gitEnv(opt.env),
    maxBuffer: 64 * 1024 * 1024, timeout: cmd === 'git' ? gitTimeout() : 30000
  })
  if (cmd === 'git') checkGitTimeout(r.error)
  if (r.error && !opt.ok) C.fail(`${cmd}: ${r.error.message}`)
  if (r.status !== 0 && !opt.ok) C.fail(`${cmd}: ${String(r.stderr || r.error?.message || r.signal || 'failed').trim().split('\n').at(-1)}`)
  return opt.ok ? r : r.stdout
}
