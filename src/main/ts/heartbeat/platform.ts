// platform: what the operating system says about a process, on macOS and Linux (Ubuntu). Elsewhere every probe says
// nothing (null) rather than guess.

import {spawnSync} from 'node:child_process'

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

// Every process with its parent and CPU seconds, from one `ps` call.
export const table = (): Map<number, {ppid: number, cpu: number}> | null => {
  if (!SUPPORTED) return null
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
