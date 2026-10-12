// host-posix stats: parsing and folding of process CPU samples; no probes, files or platform selection.

// Cumulative CPU time: [DD-][HH:]MM:SS[.ss].
export const seconds = (time: string): number => {
  const [days, rest] = time.includes('-') ? [Number(time.split('-')[0]), time.split('-')[1]] : [0, time]
  return days * 86400 + rest.split(':').reduce((acc, part) => acc * 60 + Number(part), 0)
}
// A parenthesized command may itself contain spaces or parentheses; fields follow its last closing parenthesis.
export const procStat = (line: string): {ppid: number, cpu: number} | null => {
  const f = line.slice(line.lastIndexOf(')') + 2).split(' ')
  const ppid = Number(f[1]), cpu = (Number(f[11]) + Number(f[12])) / 100
  return Number.isFinite(ppid) && Number.isFinite(cpu) ? {ppid, cpu} : null
}
export const treeCpu = (pid: number, rows: Map<number, {ppid: number, cpu: number}> | null): number | null => {
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
