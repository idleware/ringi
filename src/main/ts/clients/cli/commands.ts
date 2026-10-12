// commands: one table for the one command line: the operator's commands (operator/), `ringi agent …` for an agent
// (agent/), and the shared ones (shared/) under both; aliases kept together.
import {about} from '../../core/hub/usecases/context.ts'
import {agent} from '../../core/agents/sessions/context.ts'
import {fail} from '../../lib/index.ts'
import {inbox, take, wait, whoami} from './agent/index.ts'
import type {Opts} from './args.ts'
import {flag, out, parseArgs} from './args.ts'
import type {Ctx} from './context.ts'
import {operatorCtx} from './context.ts'
import {helpMarkdown, helpText} from './help.ts'
import {forget, heartbeats, hub, pulse, roomCmd, sessions, where} from './operator/index.ts'
import {join, leave, resume, stop} from './agent/session.ts'
import {add, cat, get, log, profileCmd, read, reply, send, signals, tasks, thread, who} from './shared/index.ts'
import {skill} from './skill/index.ts'

type Cmd = (ctx: Ctx, o: Opts) => void | Promise<void>
const SHARED: Record<string, Cmd> = {add, send, reply, read, thread, tasks, log, cat, get, who, signals, profile: profileCmd}
const AGENT: Record<string, Cmd> = {...SHARED, inbox, whoami, status: whoami, wait, take}
const agentCommand = (_: Opts, rest: string[]) => {
  const [sub = 'whoami', ...more] = rest
  const fn = AGENT[sub] ?? fail(`unknown: ringi agent ${sub}; see ringi help`)
  return fn(agent(), parseArgs(more))
}
const version = () => {
  const b = about()
  out(`ringi ${b.version}; hub contract ${b.contract}; capabilities ${b.capabilities.join(' ')}`)
}
const help = (o: Opts) => flag(o, 'md') ? void process.stdout.write(helpMarkdown()) : out(helpText())
type Direct = (o: Opts, rest: string[]) => void | Promise<void>
const DIRECT = new Map<string, Direct>([
  ['--version', version], ['-v', version], ['version', version],
  ['help', help], ['--help', help], ['-h', help], ['skill', skill], ['agent', agentCommand],
  ['hub', hub], ['room', roomCmd], ['where', where], ['sessions', sessions], ['heartbeats', heartbeats],
  ['pulse', pulse], ['forget', forget], ['join', join], ['continue', resume], ['stop', stop], ['leave', leave]
])
const unknown = (cmd: string): never => {
  if (['inbox', 'whoami', 'wait', 'take'].includes(cmd)) fail(`${cmd} is an agent command: ringi agent ${cmd}`)
  return fail(`unknown command ${cmd}; see ringi help`)
}
export const dispatch = (cmd: string, o: Opts, rest: string[]): void | Promise<void> => {
  const direct = DIRECT.get(cmd)
  if (direct) return direct(o, rest)
  const shared = SHARED[cmd] ?? unknown(cmd)
  return shared(operatorCtx(o), o)
}
