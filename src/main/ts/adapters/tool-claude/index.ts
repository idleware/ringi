// tool-claude: Claude Code. A session says so in its environment (CLAUDECODE, CLAUDE_CODE_SESSION_ID) and is known by
// its session id, `claude:<id>`. While it works it writes its transcript
// $CLAUDE_CONFIG_DIR (or ~/.claude)/projects/<dir>/<session id>.jsonl; it reads skills from .claude/skills.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {AgentTool} from '../../core/agents/ports/index.ts'
import {UUID, mtime, newestFirst} from '../tool-traces/index.ts'

const transcript = (id: string): string | null => {
  const root = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'projects')
  const dir = newestFirst(root).find(d => fs.existsSync(path.join(root, d, `${id}.jsonl`)))
  return dir ? path.join(root, dir, `${id}.jsonl`) : null
}
// A transcript once found keeps its path; only its time is read again.
const found = new Map<string, string>()

export const claude: AgentTool = {
  id: 'claude',
  detect: env => env.CLAUDECODE === '1' || !!env.CLAUDE_CODE_SESSION_ID,
  processes: ['claude'],
  session: env => env.CLAUDE_CODE_SESSION_ID ? {handle: `claude:${env.CLAUDE_CODE_SESSION_ID}`, pid: Number(env.CLAUDE_PID) || null} : null,
  traceId: s => s.handle.startsWith('claude:') || s.product === 'claude' ? UUID.exec(s.handle)?.[1] ?? null : null,
  traceTime: id => {
    if (!found.has(id)) {
      const f = transcript(id)
      if (!f) return null
      found.set(id, f)
    }
    return mtime(found.get(id)!)
  },
  skillDirs: base => [path.join(base, '.claude', 'skills', 'ringi')],
}
