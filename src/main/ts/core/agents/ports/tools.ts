// tools: the agent tools ringi works with (Claude Code, Codex, …), as a port. Each says what it can: recognise that
// this process runs in one of its sessions, name that session, where it reads skills, and what lets its sandbox write
// a path. A tool leaves out what it cannot do.

export type Env = Record<string, string | undefined>

export interface AgentTool {
  readonly id: string
  // This process runs in one of the tool's sessions, by its environment.
  detect(env: Env): boolean
  // Names of the tool's own processes, to find the session among this process's ancestors.
  readonly processes?: readonly string[]
  // The session's stable handle and its process, when the tool puts them in the environment.
  session?(env: Env): {handle: string, pid: number | null} | null
  // Where the tool reads skills under a base directory (the user's home or a project).
  skillDirs?(base: string): string[]
  // What lets the tool's sandbox write a path.
  sandboxHint?(where: string): string
}
