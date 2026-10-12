// lock: the inter-process lock.

import fs from 'node:fs'
import {errno, fail} from '../../lib/fail.ts'

// A lock is a file holding its owner (pid and a random token), created by hard-linking a file already written: it
// never exists without its owner and never replaces another lock. All acquisitions and the recovery of a dead
// owner's lock pass one gate, so two contenders cannot both clear a lock just taken by a third. A lock is taken from
// someone else only when that owner's process is gone, never by age; an unreadable owner is never taken over; only
// the owner releases it. A gate abandoned by a dead process needs the operator: recovering the recoverer would need
// yet another gate.
const ownerAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) { return errno(e) !== 'ESRCH' }
}
const ownerOf = (f: string) => {
  try { return fs.readFileSync(f, 'utf8') } catch { return null }
}
const deadOwner = (t: string | null) => {
  const pid = Number(String(t ?? '').split('.')[0])
  return Number.isInteger(pid) && pid > 0 && !ownerAlive(pid)
}
const claim = (f: string, token: string) => {
  const tmp = `${f}.${token}.tmp`
  fs.writeFileSync(tmp, token, {flag: 'wx', mode: 0o600})
  try {
    fs.linkSync(tmp, f)
    return true
  } catch (e) {
    if (errno(e) === 'EEXIST') return false
    throw e
  } finally {
    fs.rmSync(tmp, {force: true})
  }
}
const release = (f: string, token: string) => {
  if (ownerOf(f) === token) fs.rmSync(f, {force: true})
}
const lockWait = new Int32Array(new SharedArrayBuffer(4))
// One try through the gate: clear a dead owner's lock, then claim it.
const attempt = (file: string, gate: string, token: string): boolean => {
  if (!claim(gate, token)) {
    if (deadOwner(ownerOf(gate))) fail(`${gate} was abandoned; if no ringi process runs, remove it`)
    return false
  }
  try {
    if (deadOwner(ownerOf(file))) fs.rmSync(file, {force: true})
    return claim(file, token)
  } finally { release(gate, token) }
}
export const locked = <T>(file: string, fn: () => T, timeout = 120000): T => {
  const token = `${process.pid}.${Math.random().toString(36).slice(2)}`
  const until = Date.now() + timeout
  while (!attempt(file, `${file}.recover`, token)) {
    if (Date.now() >= until) fail(`${file} is held by another process or an unknown owner; if no ringi process runs, remove it`)
    Atomics.wait(lockWait, 0, 0, 25)
  }
  try { return fn() } finally { release(file, token) }
}

