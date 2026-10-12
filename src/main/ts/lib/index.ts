// lib: helpers that know nothing of ringi and touch no host: failing (fail.ts), notes, formatting, strict JSON
// (json.ts). Files and locks are the adapters' (adapters/fs).

// Notes and alarms go where the program sends them (composition/: stderr). Those written before it says where wait
// for it, so none is lost to the order modules load in.
const notes: string[] = []
let sink: ((line: string) => void) | null = null
export const notesTo = (fn: (line: string) => void): void => {
  sink = fn
  for (const line of notes.splice(0)) fn(line)
}
export const note = (s: string): void => {
  const line = `ringi: ${s}\n`
  if (sink) sink(line)
  else notes.push(line)
}
export const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
export const when = (t: number): string => `${new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ')}Z`
export const bytes = (n: number): string => n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(1)} KB` : `${(n / (1 << 20)).toFixed(1)} MB`
export const short = (id: string): string => id.slice(0, 12)
export const stamp = (): string => new Date().toISOString().slice(0, 19) + 'Z'
export const words = (v: unknown): string[] => v ? String(v).split(/[\s,]+/).filter(Boolean) : []

export * from './fail.ts'
export * from './json.ts'
