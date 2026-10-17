// help: the command table — every command, who runs it and what it does — as text, and as COMMANDS.md.

import {about} from '../../core/hub/usecases/context.ts'

// --- commands ---

// [command, who runs it, what it does]: the one table behind `ringi help` and COMMANDS.md.
export const TABLE: Array<[string, 'operator' | 'session' | 'agent' | 'both', string]> = [
  ['hub [list]', 'operator', 'the hubs this machine keeps rooms of: `local`, and one per space'],
  ['hub amend [--room <address>] -m <subject> [--set <key>=<value>]... [--attach <file>:profiles/<name>.json]...', 'operator', 'refine the shared contract of a room\'s hub (the current room\'s unless named): version, capabilities, default profile, profiles; rooms made from then on follow it'],
  ['room list', 'operator', 'the rooms on this machine, by address'],
  ['room create [<address>] [--invite <accounts>] [--profile <name>] [--quorum <agents>] [--token-file <file> --host-key-file <file>]', 'operator', 'a room for one piece of work, in its own repository, following a profile; becomes the current room. <address>: `fix` or local://fix (in the home), local:///abs/path/fix, or a room in a space on a forge, forgejo://host/space[/room] (github, gitlab, gitea alike; without a room, a random name); none: a random local room. In a space: always private; --invite prints one join line per account; the first room there needs your API token\'s file and the host\'s SSH keys as known_hosts lines. --quorum: its work starts by itself once that many agents joined'],
  ['room switch <address|name>', 'operator', 'change the terminal\'s current room; agents stay where they are'],
  ['room invite <account> [--room <address>]', 'operator', 'in a space: invite one more account; prints its join line'],
  ['room admit <actor> <public key|file> [--room <address>]', 'operator', 'in a space: admit the key an invitee\'s join printed, once the forge shows it on the invited account; the account gets the room, the chat and its own streams'],
  ['room remove <actor> [--room <address>]', 'operator', 'remove a member for good: what it wrote stays, it writes nothing more, its name is not given again; in a space its rights on the forge go too'],
  ['room delete [<address|name>] --yes [--server]', 'operator', 'take a room off this machine (default: the current room): its repository in the home is moved aside, one at a path of yours stays there, its records are archived; nothing is erased. --server: its repository on the forge is deleted first. Its sessions leave on their own'],
  ['where [-n n] [--short] [--follow]', 'operator', 'the room, its contract, sessions (active, stopped, gone), open work, latest messages'],
  ['send -m <subject> [-m <body>]... [--to <ids>] [--task] [--re <msg>] [--state <s>] [--assign <ids>] [--roles <id>=<label>,...] [--attach <src>[:<dest>]]...', 'operator', 'a message as operator; without --to it goes to the room and wakes nobody; --task opens work of the room\'s profile'],
  ['tasks [--all] | log [-n n] | read <msg> | thread <msg> | cat <msg> [<path>] | get <msg> [-o <dir>]', 'both', 'reading the room (agents: ringi agent …)'],
  ['signals [--all] [--repair]', 'both', 'what happened (signals) and where attention is (read and taken marks), each checked; --repair restores your missing signals'],
  ['profile', 'both', 'the room\'s profile: what a piece of work is, its states, who may move it'],
  ['forget <room>/<log>', 'operator', 'after a changed-history alarm: accept a new baseline for that log'],
  ['skill install | uninstall', 'operator', 'the skill for Claude Code, Codex and Cursor'],
  ['join <room> [--as <id>] [--scope <text>] [--identity <key file>]', 'session', 'bind this chat to a room as an agent, with what the operator delegates. <room>: a local room\'s address or name, joined as the chat\'s tool (claude, then claude-2…; --as names it when ringi cannot tell); or the invitation (ringi:…) to a room in a space, joined as the actor it names, once the root admitted the key it prints'],
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
  'One table. **operator**: the human in a terminal, in the current room. **session**: run in a chat on the operator\'s words. **agent**: what an agent runs during a turn, as `ringi agent …`, always in its session\'s own room. **both**: the operator directly, or an agent under `ringi agent`. Generated by `ringi help --md`; a test keeps this file in sync.', '',
  '| command | who | what |', '|---|---|---|',
  ...TABLE.map(([cmd, w, what]) => `| \`ringi ${cmd.replace(/\|/g, '\\|')}\` | ${w} | ${what} |`), '',
  'Message ids are store revisions (git: commit shas), any unique prefix of 4+ characters. States and roles come from the room\'s profile (`ringi profile`).', ''].join('\n')
