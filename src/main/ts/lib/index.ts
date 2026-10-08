// lib: helpers that know nothing of ringi: failing, notes, formatting, strict JSON, atomic files, the inter-process
// lock.

import fs from 'node:fs'

export class Fail extends Error {}
export const fail = (msg: string): never => { throw new Fail(msg) }
export const note = (s: string): void => { process.stderr.write(`ringi: ${s}\n`) }
export const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
export const when = (t: number): string => `${new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ')}Z`
export const bytes = (n: number): string => n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(1)} KB` : `${(n / (1 << 20)).toFixed(1)} MB`
export const short = (id: string): string => id.slice(0, 12)
export const stamp = (): string => new Date().toISOString().slice(0, 19) + 'Z'
export const words = (v: unknown): string[] => v ? String(v).split(/[\s,]+/).filter(Boolean) : []
export const errno = (e: unknown): string | undefined => (e as NodeJS.ErrnoException)?.code

// --- JSON files ---

export const writeJsonAtomic = (file: string, v: unknown): void => {
  const tmp = `${file}.${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2))
  fs.renameSync(tmp, file)
}
// JSON.parse silently keeps the last of duplicate fields; for contracts and authority that hides a second value.
// This parser validates the structure first and refuses duplicates.
export const strictJson = <T = unknown>(text: string, label = 'JSON'): T => {
  let at = 0
  const ws = () => { while (at < text.length && /\s/.test(text[at])) at++ }
  const bad = (): never => fail(`${label}: malformed or duplicate JSON field at ${at}`)
  const str = (): string => {
    const start = at++
    while (at < text.length && text[at] !== '"') at += text[at] === '\\' ? 2 : 1
    if (text[at++] !== '"') bad()
    try { return JSON.parse(text.slice(start, at)) } catch { return bad() }
  }
  const value = (): void => {
    ws()
    const c = text[at]
    if (c === '{') {
      at++
      ws()
      const keys = new Set<string>()
      if (text[at] === '}') { at++; return }
      for (;;) {
        ws()
        if (text[at] !== '"') bad()
        const k = str()
        if (keys.has(k)) bad()
        keys.add(k)
        ws()
        if (text[at++] !== ':') bad()
        value()
        ws()
        const n = text[at++]
        if (n === '}') return
        if (n !== ',') bad()
      }
    }
    if (c === '[') {
      at++
      ws()
      if (text[at] === ']') { at++; return }
      for (;;) {
        value()
        ws()
        const n = text[at++]
        if (n === ']') return
        if (n !== ',') bad()
      }
    }
    if (c === '"') { str(); return }
    const m = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(at))
    if (!m) bad()
    at += m![0].length
  }
  value()
  ws()
  if (at !== text.length) bad()
  return JSON.parse(text) as T
}

// --- the lock ---

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
export const locked = <T>(file: string, fn: () => T, timeout = 120000): T => {
  const token = `${process.pid}.${Math.random().toString(36).slice(2)}`
  const gate = `${file}.recover`
  const until = Date.now() + timeout
  for (;;) {
    if (claim(gate, token)) {
      try {
        if (deadOwner(ownerOf(file))) fs.rmSync(file, {force: true})
        if (claim(file, token)) break
      } finally { release(gate, token) }
    } else if (deadOwner(ownerOf(gate))) {
      fail(`${gate} was abandoned; if no ringi process runs, remove it`)
    }
    if (Date.now() >= until) fail(`${file} is held by another process or an unknown owner; if no ringi process runs, remove it`)
    Atomics.wait(lockWait, 0, 0, 25)
  }
  try { return fn() } finally { release(file, token) }
}

// --- writing where a sandbox may refuse ---

export const SANDBOX = /Operation not permitted|Permission denied|Read-only file system|EPERM|EACCES|EROFS/
export const cannotWrite = (where: string, detail: string): never => fail(`cannot write ${where}: ${detail}
  An agent in a sandbox: re-run this same command with your host's sandbox escalation; the operator approves it.
  The operator can instead add ${where} to the host's writable roots (Codex: [sandbox_workspace_write] writable_roots
  in ~/.codex/config.toml) or point RINGI_HOME at a location the host already allows.`)
export const guardWrite = <T>(where: string, fn: () => T): T => {
  try { return fn() } catch (e) {
    if (e instanceof Fail) throw e
    if (['EPERM', 'EACCES', 'EROFS'].includes(errno(e) ?? '')) cannotWrite(where, `${errno(e)} on ${(e as NodeJS.ErrnoException).path ?? 'a file'}`)
    throw e
  }
}
export const mkdirIn = (where: string, d: string): void => { guardWrite(where, () => fs.mkdirSync(d, {recursive: true, mode: 0o700})) }
