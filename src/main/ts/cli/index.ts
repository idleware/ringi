// ringi: a distributed agent coordinator (docs/spec/hub-1.md). This file is the command surface: what the operator, a session
// and an agent may run, and how each command maps onto hubs, rooms, sessions and the watcher.

import {about, agent} from '../app/context.ts'
import type {Profile} from '../domain/profiles.ts'
import {fail, words} from '../lib/index.ts'
import {flag, opt, out, parseArgs} from './args.ts'
import type {Opts} from './args.ts'
import {watch} from '../app/agent.ts'
import {card, inbox, ping, take, wait, whoami} from './agent.ts'
import {operatorCtx} from './context.ts'
import {forget, hub, roomCmd, sessions, where} from './operator.ts'
import {join, leave, resume, stop} from './session.ts'
import {cat, decide, get, grants, log, profileCmd, proposals, propose, read, reply, send, signals, stamp_, tasks, thread, who} from './shared.ts'
import {skill} from './skill.ts'
import type {Ctx} from './context.ts'


// --- commands ---

// [command, who runs it, what it does]: the one table behind `ringi help` and COMMANDS.md.
export const TABLE: Array<[string, 'operator' | 'session' | 'agent' | 'both', string]> = [
  ['hub [list]', 'operator', 'the hubs; `local` exists by default; * marks the current one'],
  ['hub create <name> [--signed [--url <git url>]]', 'operator', 'another hub: asserted senders, or signed with a root key made on this machine; --url publishes it'],
  ['hub add <name> <git url> --root <public key|file> [--genesis <sha>]', 'operator', 'a replica of a signed hub; the root key comes from you, out of band, never from the hub'],
  ['hub switch <name>', 'operator', 'change the terminal\'s current hub; agents stay where they are'],
  ['hub amend -m <subject> [--set <key>=<value>]... [--authority <file>] [--attach <file>:profiles/<name>.json]...', 'operator', 'refine the shared contract: version, capabilities, default profile, authority table, profiles'],
  ['room list [--archived]', 'operator', 'rooms of the current hub'],
  ['room create <id> [--profile <name>]', 'operator', 'a room for one piece of work, following a profile; becomes the current room'],
  ['room migrate <id>', 'operator', 'local hubs: join the old room branches without changing message ids or sessions'],
  ['room switch <id>', 'operator', 'change the terminal\'s current room; agents stay where they are'],
  ['room admit <agent> <public key|file>', 'operator', 'signed hubs: admit the key an agent made on its own machine'],
  ['room remove <agent>', 'operator', 'local hubs: take an agent out of the current room'],
  ['room archive <id>', 'operator', 'local hubs: read-only from now on; wakes nobody; its sessions end'],
  ['room delete <id> --yes', 'operator', 'local hubs: erase a room and everything kept for it; its sessions leave on their own'],
  ['room rebase-contract <id>', 'operator', 'move a room onto the hub\'s current contract'],
  ['where [-n n] [--short] [--follow]', 'operator', 'hub, room, sessions (active, stopped, gone), open work and proposals, latest messages'],
  ['send -m <subject> [-m <body>]... [--to <ids>] [--task] [--re <msg>] [--state <s>] [--assign <ids>] [--roles <id>=<label>,...] [--grant <decision>] [--attach <src>[:<dest>]]...', 'operator', 'a message as operator; without --to it goes to the room and wakes nobody; --task opens work of the room\'s profile'],
  ['propose -m <subject> [-m <body>] --decider <id> [--reviewers <ids>] [--due 2h|<ISO>] [--budget runs=<n>,run-seconds=<n>,concurrency=<n>] [--supersedes <proposal>]', 'both', 'a proposal; it circulates to the reviewers and the decider'],
  ['stamp <proposal> approve|object|abstain -m <reason>', 'both', 'a named reviewer\'s stamp on that exact revision'],
  ['decide <proposal> approved|rejected|revoked -m <reason>', 'both', 'the named decider, with authority; an approval with a budget is a grant'],
  ['proposals [--all] | grants', 'both', 'open proposals with their stamps; grants with their usage'],
  ['tasks [--all] | log [-n n] | read <msg> | thread <msg> | cat <msg> [<path>] | get <msg> [-o <dir>] | who', 'both', 'reading the room (agents: ringi agent …)'],
  ['signals [--all] [--repair]', 'both', 'what happened (signals) and where attention is (read and taken marks), each checked; --repair restores your missing signals'],
  ['profile', 'both', 'the room\'s profile: what a piece of work is, its states, who may move it'],
  ['sessions | sessions forget <handle>', 'operator', 'the chats the CLI remembers; drop a stale one'],
  ['forget <room>/<log>', 'operator', 'after a changed-history alarm: accept a new baseline for that log'],
  ['watch [<hub>:]<room>/<agent> --exec <cmd> [--handoff] [--scope <text>] [--once] [--require-grant] [--from <ids>] [--max-hop n] [--max-runs n] [--window s] [--interval s]', 'operator', 'headless turns for one agent: answers pings, spends grants, writes usage receipts; --handoff, run from the agent\'s own chat, moves its seat and scope to the watcher; exits with the failed turn\'s status'],
  ['skill install [--project] | uninstall | status | show', 'operator', 'the skill for Claude Code, Codex and Cursor'],
  ['join <hub> <room> [--as <id>] [--scope <text>]', 'session', 'bind this chat to a room as an agent, with what the operator delegates'],
  ['continue [[<hub>:]<room>/<agent>]', 'session', 'resume this chat\'s binding, also after a restart; naming one takes over a paused or gone one'],
  ['stop', 'session', 'pause: keep the seat, react to nothing'],
  ['leave', 'session', 'release the seat'],
  ['agent whoami', 'agent', 'identity, room, profile, scope'],
  ['agent inbox [--peek] [--limit n]', 'agent', 'what is new for you; marks it seen and leaves a read mark on each (--peek: neither)'],
  ['agent take <work>', 'agent', 'a taken mark: you are on it; others see it in tasks and read. It changes no state'],
  ['agent send … | reply <msg> -m … [--state <s>] [--assign <ids>] [--roles …] [--grant <decision>] [--attach …] [--all]', 'agent', 'write; answer the message you act on'],
  ['agent propose | stamp | decide | proposals | grants', 'agent', 'decisions, as the joined agent'],
  ['agent tasks | log | read | thread | cat | get | who | signals | profile', 'agent', 'reading, as the joined agent'],
  ['agent ping <id> [-m <note>] [--next <s>] | agent wait [--max <s>] | agent card -m <text>', 'agent', 'heartbeats; hold the line only when the operator asks; who you are'],
]
const helpText = () => {
  const groups: Array<[string, string]> = [['operator', 'operator: in a terminal, in the current hub and room'], ['session', 'session: in a chat, on the operator\'s words'], ['agent', 'agent: during a turn, in the session\'s own room'], ['both', 'operator in a terminal, or an agent as ringi agent …']]
  const width = 56
  const line = ([cmd, , what]: (typeof TABLE)[number]) => cmd.length > width ? `  ringi ${cmd}\n  ${' '.repeat(width + 6)} ${what}` : `  ringi ${cmd.padEnd(width)} ${what}`
  return [`ringi ${about().version}: distributed agent coordinator. Home: ${about().home} (RINGI_HOME).`,
    ...groups.flatMap(([w, title]) => ['', title, ...TABLE.filter(r => r[1] === w).map(line)]),
    '', 'message ids are store revisions (git: commit shas); any unique prefix of 4+ characters works. States and roles come from the room\'s profile: ringi profile'].join('\n')
}
export const helpMarkdown = (): string => ['# ringi commands', '',
  'One table. **operator**: the human in a terminal, in the current hub and room. **session**: run in a chat on the operator\'s words. **agent**: what an agent runs during a turn, as `ringi agent …`, always in its session\'s own room. **both**: the operator directly, or an agent under `ringi agent`. Generated by `ringi help --md`; a test keeps this file in sync.', '',
  '| command | who | what |', '|---|---|---|',
  ...TABLE.map(([cmd, w, what]) => `| \`ringi ${cmd.replace(/\|/g, '\\|')}\` | ${w} | ${what} |`), '',
  'Message ids are store revisions (git: commit shas), any unique prefix of 4+ characters. States and roles come from the room\'s profile (`ringi profile`).', ''].join('\n')

type Cmd = (ctx: Ctx, o: Opts) => void | Promise<void>
const SHARED: Record<string, Cmd> = {send, reply, read, thread, tasks, log, cat, get, who, signals, profile: profileCmd, propose, stamp: stamp_, decide, proposals, grants}
const AGENT: Record<string, Cmd> = {...SHARED, inbox, whoami, status: whoami, card, ping, wait, take}

// A reader that stops early (`ringi log | head`) closes the pipe: that ends the output, not the command's work.
const quietPipe = (e: NodeJS.ErrnoException) => { if (e.code === 'EPIPE') process.exit(process.exitCode ?? 0); else throw e }
export const main = async (argv = process.argv.slice(2)): Promise<void> => {
  if (!process.stdout.listeners('error').includes(quietPipe)) process.stdout.on('error', quietPipe)
  const [cmd = 'help', ...rest] = argv
  const o = cmd === 'agent' ? {_: []} as Opts : parseArgs(rest)
  if (['--version', '-v', 'version'].includes(cmd)) { const b = about(); return out(`ringi ${b.version}; hub contract ${b.contract}; capabilities ${b.capabilities.join(' ')}`) }
  if (['help', '--help', '-h'].includes(cmd)) return flag(o, 'md') ? void process.stdout.write(helpMarkdown()) : out(helpText())
  if (cmd === 'skill') return skill(o)
  if (cmd === 'agent') {
    const [sub = 'whoami', ...more] = rest
    const fn = AGENT[sub] ?? fail(`unknown: ringi agent ${sub}; see ringi help`)
    return fn(agent(), parseArgs(more))
  }
  if (cmd === 'hub') return hub(o)
  if (cmd === 'room') return roomCmd(o)
  if (cmd === 'where') return where(o)
  if (cmd === 'sessions') return sessions(o)
  if (cmd === 'forget') return forget(o)
  if (cmd === 'watch') {
    const num = (k: string) => opt(o, k) === undefined ? undefined : Number(opt(o, k))
    process.exitCode = await watch({seat: o._[0] ?? fail('usage: ringi watch <room>/<agent> --exec <cmd> [--scope <text>] [--once] [--require-grant] …'),
      exec: opt(o, 'exec') ?? fail('--exec <cmd> is required: the command that starts a headless turn'),
      hub: opt(o, 'hub'), scope: opt(o, 'scope'), once: flag(o, 'once'), requireGrant: flag(o, 'require-grant'), handoff: flag(o, 'handoff'),
      interval: num('interval'), from: opt(o, 'from') ? words(opt(o, 'from')) : undefined, maxHop: num('max-hop'),
      maxRuns: num('max-runs'), window: num('window')}, out)
    return
  }
  if (cmd === 'join') return join(o)
  if (cmd === 'continue') return resume(o)
  if (cmd === 'stop') return stop()
  if (cmd === 'leave') return leave()
  if (SHARED[cmd]) return SHARED[cmd](operatorCtx(o), o)
  if (['inbox', 'whoami', 'ping', 'wait', 'card'].includes(cmd)) fail(`${cmd} is an agent command: ringi agent ${cmd}`)
  fail(`unknown command ${cmd}; see ringi help`)
}

export type {Profile}

