// host-posix: what macOS and Linux say about a process, and a detached start, behind ProcessHost
// (core/agents/ports/host.ts). Elsewhere every probe says nothing rather than guess.

import {spawn, spawnSync} from 'node:child_process'
import path from 'node:path'
import type {Ancestor, ProcessHost} from '../../core/agents/ports/host.ts'

const supported = process.platform === 'darwin' || process.platform === 'linux'
// A process of another user that we may not signal still exists.
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}
// Up to twelve parents by name, from one `ps` call each; a sandbox that denies `ps` gets none.
const ancestors = (first: number): Ancestor[] => {
  const result: Ancestor[] = []
  for (let pid = first, i = 0; i < 12 && pid > 1; i++) {
    const r = spawnSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], {encoding: 'utf8'})
    const m = r.status === 0 ? /^\s*(\d+)\s+(.*)$/.exec(String(r.stdout ?? '').trim()) : null
    if (!m) break
    result.push({pid, name: path.basename(m[2].trim()).toLowerCase()})
    pid = Number(m[1])
  }
  return result
}

export const hostPosix = (): ProcessHost => ({
  supported, alive, ancestors,
  start: ({file, args, env}) => { spawn(file, [...args], {detached: true, stdio: 'ignore', env}).unref() },
})
