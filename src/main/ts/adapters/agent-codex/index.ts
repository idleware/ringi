// agent-codex: Codex. A session says so in its environment (CODEX_*); a chat names itself on every ringi command with
// RINGI_SESSION=codex-<thread id>. It reads skills from .agents/skills, and its sandbox writes where its writable roots
// allow.

import path from 'node:path'
import type {AgentTool} from '../../core/agents/ports/index.ts'

export const codex: AgentTool = {
  id: 'codex',
  detect: env => Object.keys(env).some(k => k.startsWith('CODEX_')),
  processes: ['codex'],
  skillDirs: base => [path.join(base, '.agents', 'skills', 'ringi')],
  sandboxHint: where => `Codex: the narrowest grant is [sandbox_workspace_write] writable_roots = ["${where}"] in ~/.codex/config.toml.`,
}
