// tools: the trace each agent tool writes of a session while it works, found by the session's id. Its modification
// time is the session's own activity, unlike the CPU of an app process that hosts many sessions.
//   Claude Code   $CLAUDE_CONFIG_DIR (or ~/.claude)/projects/<dir>/<session id>.jsonl, the session's transcript
//   Codex         $CODEX_HOME (or ~/.codex)/sessions/<yyyy>/<mm>/<dd>/rollout-<time>-<thread id>.jsonl
// A ringi watcher writes no trace of its own: the CPU of its process tree speaks for its turn (platform.ts).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/
const dirs = (d: string): string[] => { try { return fs.readdirSync(d).sort().reverse() } catch { return [] } }
const mtime = (f: string): number | null => { try { return fs.statSync(f).mtimeMs / 1000 } catch { return null } }

const claude = (id: string): string | null => {
  const root = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'projects')
  for (const d of dirs(root)) if (fs.existsSync(path.join(root, d, `${id}.jsonl`))) return path.join(root, d, `${id}.jsonl`)
  return null
}
const codex = (id: string): string | null => {
  const root = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'sessions')
  for (const y of dirs(root)) for (const m of dirs(path.join(root, y))) for (const d of dirs(path.join(root, y, m))) {
    const f = dirs(path.join(root, y, m, d)).find(n => n.startsWith('rollout-') && n.endsWith(`-${id}.jsonl`))
    if (f) return path.join(root, y, m, d, f)
  }
  return null
}
// A trace once found keeps its path; only its time is read again.
const found = new Map<string, string>()

// Which tool a session runs and the id its trace is named by: Claude Code sessions are `claude:<id>`; a Codex chat
// names itself with RINGI_SESSION=codex-<thread id>.
export const toolOf = (s: {handle: string, product: string | null}): {tool: 'claude' | 'codex', id: string} | null => {
  const id = UUID.exec(s.handle)?.[1]
  if (!id) return null
  if (s.handle.startsWith('claude:') || s.product === 'claude') return {tool: 'claude', id}
  if (s.product === 'codex' || s.handle.startsWith('env:codex-')) return {tool: 'codex', id}
  return null
}
// When the session's tool last wrote its trace (unix seconds), or null: no tool known, or no trace found.
export const traceTime = (s: {handle: string, product: string | null}): number | null => {
  const t = toolOf(s)
  if (!t) return null
  const key = `${t.tool}:${t.id}`
  if (!found.has(key)) {
    const f = t.tool === 'claude' ? claude(t.id) : codex(t.id)
    if (!f) return null
    found.set(key, f)
  }
  return mtime(found.get(key)!)
}
