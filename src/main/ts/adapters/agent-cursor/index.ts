// agent-cursor: Cursor, recognised only: a session says so in its environment (CURSOR_*) or by its process. It names no
// session and gets no skill.

import type {AgentTool} from '../../core/agents/ports/index.ts'

export const cursor: AgentTool = {
  id: 'cursor',
  detect: env => Object.keys(env).some(k => k.startsWith('CURSOR_')),
  processes: ['cursor', 'cursor-agent'],
}
