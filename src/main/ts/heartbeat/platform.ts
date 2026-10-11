// platform: what the operating system says about a process, on macOS and Linux (Ubuntu). Elsewhere every probe says
// nothing (null) rather than guess.

import {spawnSync} from 'node:child_process'
import fs from 'node:fs'

export const SUPPORTED = process.platform === 'darwin' || process.platform === 'linux'

// Whether the process exists; a process of another user that we may not signal still exists.
export const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

// `ps` cumulative CPU time: `[DD-][HH:]MM:SS[.ss]` on both systems.
export const seconds = (time: string): number => {
  const [days, rest] = time.includes('-') ? [Number(time.split('-')[0]), time.split('-')[1]] : [0, time]
  return days * 86400 + rest.split(':').reduce((acc, part) => acc * 60 + Number(part), 0)
}

// One line of /proc/<pid>/stat: the parent and the CPU seconds (user + system, in clock ticks of 1/100 s). The command
// name is in parentheses and may hold spaces, so the fields are counted after the last `)`.
export const procStat = (line: string): {ppid: number, cpu: number} | null => {
  const f = line.slice(line.lastIndexOf(')') + 2).split(' ')
  const ppid = Number(f[1]), cpu = (Number(f[11]) + Number(f[12])) / 100
  return Number.isFinite(ppid) && Number.isFinite(cpu) ? {ppid, cpu} : null
}
// Linux: /proc gives CPU to the hundredth of a second, where `ps` rounds to whole seconds.
const proc = (): Map<number, {ppid: number, cpu: number}> | null => {
  let pids: string[]
  try { pids = fs.readdirSync('/proc').filter(d => /^\d+$/.test(d)) } catch { return null }
  const rows = new Map<number, {ppid: number, cpu: number}>()
  for (const pid of pids) {
    try {
      const row = procStat(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'))
      if (row) rows.set(Number(pid), row)
    } catch { /* the process ended meanwhile */ }
  }
  return rows.size ? rows : null
}
// Every process with its parent and CPU seconds: /proc on Linux, else one `ps` call.
export const table = (): Map<number, {ppid: number, cpu: number}> | null => {
  if (!SUPPORTED) return null
  if (process.platform === 'linux') { const rows = proc(); if (rows) return rows }
  const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,time='], {encoding: 'utf8', timeout: 10000})
  if (r.status !== 0) return null
  const rows = new Map<number, {ppid: number, cpu: number}>()
  for (const line of r.stdout.split('\n')) {
    const [pid, ppid, time] = line.trim().split(/\s+/)
    if (pid && time) rows.set(Number(pid), {ppid: Number(ppid), cpu: seconds(time)})
  }
  return rows
}

// CPU seconds the process and all its descendants used so far: a turn's model client, its tools and their children.
export const treeCpu = (pid: number, rows = table()): number | null => {
  if (!rows?.has(pid)) return null
  const children = new Map<number, number[]>()
  for (const [p, {ppid}] of rows) children.set(ppid, [...children.get(ppid) ?? [], p])
  let sum = 0
  for (const stack = [pid]; stack.length;) {
    const p = stack.pop()!
    sum += rows.get(p)?.cpu ?? 0
    stack.push(...children.get(p) ?? [])
  }
  return sum
}
