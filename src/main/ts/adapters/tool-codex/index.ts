// tool-codex: Codex. A session says so in its environment (CODEX_*); a chat names itself on every ringi command with
// RINGI_SESSION=codex-<thread id>. While it works it writes its rollout
// $CODEX_HOME (or ~/.codex)/sessions/<yyyy>/<mm>/<dd>/rollout-<time>-<thread id>.jsonl; it reads skills from
// .agents/skills, and its sandbox writes where its writable roots allow.

import os from 'node:os'
import path from 'node:path'
import type {AgentTool} from '../../core/agents/ports/index.ts'
import {UUID, mtime, newestFirst} from '../tool-traces/index.ts'

const rollout = (id: string): string | null => {
  const root = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'sessions')
  for (const y of newestFirst(root)) for (const m of newestFirst(path.join(root, y))) for (const d of newestFirst(path.join(root, y, m))) {
    const f = newestFirst(path.join(root, y, m, d)).find(n => n.startsWith('rollout-') && n.endsWith(`-${id}.jsonl`))
    if (f) return path.join(root, y, m, d, f)
  }
  return null
}
// A rollout once found keeps its path; only its time is read again.
const found = new Map<string, string>()

export const codex: AgentTool = {
  id: 'codex',
  detect: env => Object.keys(env).some(k => k.startsWith('CODEX_')),
  processes: ['codex'],
  traceId: s => s.product === 'codex' || s.handle.startsWith('env:codex-') ? UUID.exec(s.handle)?.[1] ?? null : null,
  traceTime: id => {
    if (!found.has(id)) {
      const f = rollout(id)
      if (!f) return null
      found.set(id, f)
    }
    return mtime(found.get(id)!)
  },
  skillDirs: base => [path.join(base, '.agents', 'skills', 'ringi')],
  sandboxHint: where => `Codex: the narrowest grant is [sandbox_workspace_write] writable_roots = ["${where}"] in ~/.codex/config.toml.`,
}
