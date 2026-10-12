// tools: which agent tool a session runs in, and when that tool last wrote the session's trace, asked of the tools
// this machine knows (core/agents/ports/tools.ts). Its modification time is the session's own activity, unlike the CPU of an app
// process that hosts many sessions.

import {agentPorts} from '../ports/index.ts'
import type {AgentTool, SessionRef} from '../ports/index.ts'

const traced = (s: SessionRef): {tool: AgentTool, id: string} | null => {
  for (const tool of agentPorts().tools) {
    const id = tool.traceId?.(s)
    if (id) return {tool, id}
  }
  return null
}
// The tool the session runs in and the id its trace is named by.
export const toolOf = (s: SessionRef): {tool: string, id: string} | null => {
  const t = traced(s)
  return t && {tool: t.tool.id, id: t.id}
}
// When the session's tool last wrote its trace (unix seconds), or null: no tool known, or no trace found.
export const traceTime = (s: SessionRef): number | null => {
  const t = traced(s)
  return t?.tool.traceTime?.(t.id) ?? null
}
