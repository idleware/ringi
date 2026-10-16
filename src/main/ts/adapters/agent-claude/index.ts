// agent-claude: Claude Code. A session says so in its environment (CLAUDECODE, CLAUDE_CODE_SESSION_ID) and is known by
// its session id, `claude:<id>`; it reads skills from .claude/skills.

import path from 'node:path'
import type {AgentTool} from '../../core/agents/ports/index.ts'

export const claude: AgentTool = {
  id: 'claude',
  detect: env => env.CLAUDECODE === '1' || !!env.CLAUDE_CODE_SESSION_ID,
  processes: ['claude'],
  session: env => env.CLAUDE_CODE_SESSION_ID ? {handle: `claude:${env.CLAUDE_CODE_SESSION_ID}`, pid: Number(env.CLAUDE_PID) || null} : null,
  skillDirs: base => [path.join(base, '.claude', 'skills', 'ringi')],
}
