// Dispatch tables share the existing command implementations and keep aliases together.
import {about} from '../../core/hub/usecases/context.ts'
import {agent} from '../../core/agents/sessions/context.ts'
import {fail} from '../../lib/index.ts'
import {card, inbox, ping, take, wait, whoami} from './agent.ts'
import type {Opts} from './args.ts'
import {flag, out, parseArgs} from './args.ts'
import type {Ctx} from './context.ts'
import {operatorCtx} from './context.ts'
import {helpMarkdown, helpText} from './help.ts'
import {forget, heartbeats, hub, pulse, roomCmd, sessions, where} from './operator.ts'
import {join, leave, resume, stop} from './session.ts'
import {add, cat, decide, get, grants, log, profileCmd, proposals, propose, read, reply, send, signals, stamp_, tasks, thread, who} from './shared.ts'
import {skill} from './skill.ts'
import {watchCommand} from './watch.ts'

type Cmd = (ctx: Ctx, o: Opts) => void | Promise<void>
const SHARED: Record<string, Cmd> = {add, send, reply, read, thread, tasks, log, cat, get, who, signals, profile: profileCmd, propose, stamp: stamp_, decide, proposals, grants}
const AGENT: Record<string, Cmd> = {...SHARED, inbox, whoami, status: whoami, card, ping, wait, take}
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
  ['pulse', pulse], ['forget', forget], ['watch', watchCommand], ['join', join], ['continue', resume], ['stop', stop], ['leave', leave]
])
const unknown = (cmd: string): never => {
  if (['inbox', 'whoami', 'ping', 'wait', 'card'].includes(cmd)) fail(`${cmd} is an agent command: ringi agent ${cmd}`)
  return fail(`unknown command ${cmd}; see ringi help`)
}
export const dispatch = (cmd: string, o: Opts, rest: string[]): void | Promise<void> => {
  const direct = DIRECT.get(cmd)
  if (direct) return direct(o, rest)
  const shared = SHARED[cmd] ?? unknown(cmd)
  return shared(operatorCtx(o), o)
}
