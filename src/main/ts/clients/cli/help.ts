// help: the command table — every command, who runs it and what it does — as text, and as COMMANDS.md.

import {about} from '../../core/hub/usecases/context.ts'

// --- commands ---

// [command, who runs it, what it does]: the one table behind `ringi help` and COMMANDS.md.
export const TABLE: Array<[string, 'operator' | 'session' | 'agent' | 'both', string]> = [
  ['hub [list]', 'operator', 'the hubs; `local` exists by default'],
  ['hub create <name> [--signed [--url <address>]]', 'operator', 'another hub: asserted senders, or signed with a root key made on this machine; --url publishes its contract (an address names its store: git+ssh://…, git+https://…, git+file://…)'],
  ['hub amend [--hub <name>] -m <subject> [--set <key>=<value>]... [--attach <file>:profiles/<name>.json]...', 'operator', 'refine the shared contract (of hub local unless named): version, capabilities, default profile, profiles; rooms made from then on follow it'],
  ['room list', 'operator', 'the rooms on this machine; a room\'s name is unique here, whatever hub keeps it'],
  ['room create <id> [--hub <name>] [--profile <name>] [--quorum <agents>] [--url <address>]', 'operator', 'a room for one piece of work, in its own repository (in hub local unless named), following a profile; becomes the current room; --quorum: its work starts by itself once that many agents joined (1: at once); --url: a signed hub publishes the room there and prints the join line for agents elsewhere'],
  ['room switch <id>', 'operator', 'change the terminal\'s current room; agents stay where they are'],
  ['room admit <agent> <public key|file>', 'operator', 'signed hubs: admit the key an agent made on its own machine'],
  ['room delete [<id>] --yes', 'operator', 'erase a room\'s store on this machine (default: the current room) and everything kept for it; its sessions leave on their own'],
  ['where [-n n] [--short] [--follow]', 'operator', 'the room, its hub and contract, sessions (active, stopped, gone), open work, latest messages'],
  ['send -m <subject> [-m <body>]... [--to <ids>] [--task] [--re <msg>] [--state <s>] [--assign <ids>] [--roles <id>=<label>,...] [--attach <src>[:<dest>]]...', 'operator', 'a message as operator; without --to it goes to the room and wakes nobody; --task opens work of the room\'s profile'],
  ['tasks [--all] | log [-n n] | read <msg> | thread <msg> | cat <msg> [<path>] | get <msg> [-o <dir>]', 'both', 'reading the room (agents: ringi agent …)'],
  ['signals [--all] [--repair]', 'both', 'what happened (signals) and where attention is (read and taken marks), each checked; --repair restores your missing signals'],
  ['profile', 'both', 'the room\'s profile: what a piece of work is, its states, who may move it'],
  ['heartbeats [--json] | heartbeats --published [--room <id>]', 'operator', 'each session\'s pulse on this machine, from its process and its tool\'s trace, without the model: working, waiting (for what) or gone; --published: the room\'s heartbeat tags as an orchestrator reads them'],
  ['pulse [--beat <s>] [--once]', 'operator', 'beat for every session here: sync its room, append its telemetry, naming the last pulled message of its room; join and continue start it (RINGI_PULSE=off: not)'],
  ['forget <room>/<log>', 'operator', 'after a changed-history alarm: accept a new baseline for that log'],
  ['skill install | uninstall', 'operator', 'the skill for Claude Code, Codex and Cursor'],
  ['join <room> [--as <id>] [--scope <text>]', 'session', 'bind this chat to a room as an agent, with what the operator delegates; <room>: its name on this machine, or the operator\'s invitation (ringi:…) to one elsewhere'],
  ['continue [<room>/<agent>]', 'session', 'resume this chat\'s binding, also after a restart; naming one takes over a paused or gone one'],
  ['stop', 'session', 'pause: keep the seat, react to nothing'],
  ['leave', 'session', 'release the seat'],
  ['agent whoami', 'agent', 'identity, room, profile, scope'],
  ['agent inbox [--peek] [--limit n]', 'agent', 'what is new for you; marks it seen and leaves a read mark on each (--peek: neither)'],
  ['agent take <work>', 'agent', 'a taken mark: you are on it; others see it in tasks and read. It changes no state'],
  ['agent send … | reply <msg> -m … [--state <s>] [--assign <ids>] [--roles …] [--attach …] [--all]', 'agent', 'write; answer the message you act on'],
  ['agent tasks | log | read | thread | cat | get | signals | profile', 'agent', 'reading, as the joined agent'],
  ['agent wait [--max <s>]', 'agent', 'hold the line only when the operator asks'],
]

export const helpText = () => {
  const groups: Array<[string, string]> = [['operator', 'operator: in a terminal, in the current room'], ['session', 'session: in a chat, on the operator\'s words'], ['agent', 'agent: during a turn, in the session\'s own room'], ['both', 'operator in a terminal, or an agent as ringi agent …']]
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
