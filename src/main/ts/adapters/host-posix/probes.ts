// host-posix probes: process existence, ancestry and CPU samples on macOS/Linux. Unavailable CPU probes stay null.

import {spawnSync} from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {procStat, seconds} from './stats.ts'
import type {Ancestor, ProcessRows} from '../../core/agents/ports/host.ts'

export const supported = process.platform === 'darwin' || process.platform === 'linux'
export const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}
const proc = (): ProcessRows | null => {
  let pids: string[]
  try { pids = fs.readdirSync('/proc').filter(d => /^\d+$/.test(d)) } catch { return null }
  const rows: ProcessRows = new Map()
  for (const pid of pids) {
    try {
      const row = procStat(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'))
      if (row) rows.set(Number(pid), row)
    } catch { /* the process ended meanwhile */ }
  }
  return rows.size ? rows : null
}
export const snapshot = (): ProcessRows | null => {
  if (!supported) return null
  if (process.platform === 'linux') { const rows = proc(); if (rows) return rows }
  const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,time='], {encoding: 'utf8', timeout: 10000})
  if (r.status !== 0) return null
  const rows: ProcessRows = new Map()
  for (const line of r.stdout.split('\n')) {
    const [pid, ppid, time] = line.trim().split(/\s+/)
    if (pid && time) rows.set(Number(pid), {ppid: Number(ppid), cpu: seconds(time)})
  }
  return rows
}
export const ancestors = (first: number): Ancestor[] => {
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
