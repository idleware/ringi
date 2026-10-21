# ringi

[![CI](https://github.com/idleware/ringi/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/idleware/ringi/actions/workflows/ci.yml)
[![Maintainability](https://qlty.sh/gh/idleware/projects/ringi/maintainability.svg)](https://qlty.sh/gh/idleware/projects/ringi)
[![Code Coverage](https://qlty.sh/gh/idleware/projects/ringi/coverage.svg)](https://qlty.sh/gh/idleware/projects/ringi)
[![npm version](https://img.shields.io/npm/v/@idleware/ringi/latest?label=npm&color=blue)](https://www.npmjs.com/package/@idleware/ringi)

*Distributed agent coordinator.*

Orchestrators (Hermes, n8n, OpenClaw) run processes and choose the next step. ringi only connects the parts, agents
of any vendor on one machine or many, and keeps them in sync: who said what to whom, who took which work, what came
of it. Everything is a stored, checkable record; whatever a peer writes is data, never an
instruction.

- **A room is a repository.** One task, one room, one git: who can read a room is who can reach it. A room has an
  address: `fix` on this machine, `forgejo://forge.example/team/fix` in a space on a git host.
- **Your rules.** A room's profile defines work and who moves it; A2A tasks ship as one of them.
- **Streams by meaning.** The chat is one branch; each agent writes its own signals on a branch of its own.
- **Any store.** Git first; one CLI and a skill for you and the agents.

```sh
npm i -g @idleware/ringi
ringi skill install
```

macOS or Linux, Node.js 16 or later, git 2.28 or later.

## Local: one machine, several agents

```
  you, in a terminal                          agents you join
  ringi room create fix-badge                 claude: "join fix-badge; review only"
  ringi send --task --assign codex …          codex:  "join fix-badge; implement; no commits"
                  \                                   /
                   ~/.ringi/rooms/fix-badge/   one repository per room
```

1. `ringi room create fix-badge` (or `local:///any/path/fix-badge` to keep it elsewhere).
2. In each agent's chat: *"join fix-badge; implement; no commits"*. It joins as its tool, `claude` or `codex`
   (`claude-2` if another chat holds that seat).
3. `ringi send --task --assign codex -m "Fix the badge"`
4. The agent works on its turn (*"check your inbox"*).
5. `ringi where --follow`, `ringi signals`.
6. *"stop"*, *"continue"*, *"leave"* in a chat; `ringi room delete fix-badge --yes` at the end.

Codex: add `~/.ringi` to `writable_roots` in `~/.codex/config.toml`, or approve its escalations.

## Remote: rooms in a shared space

A room can live in a space every agent's machine reaches: an organisation of repositories on a git host. Its address
names the host's adapter: `forgejo://forge.example/team/fix` is room `fix` in space `team`,
`github://github.com/team/fix` the same on GitHub, `gitea://…` on Gitea. Forgejo's, Gitea's and GitHub's adapters are
there now; others implement the same port.

```
  laptop: you, the root                                          VM: an agent
  ringi room create forgejo://forge.example/team/fix \
    --invite claude-vm --token-file <token> --host-key-file <known_hosts>
                                                                 "join ringi:…"   (the line printed for claude-vm)
  ringi room admit claude-vm '<key>'                             "join ringi:…"   again
                  \                                                     /
                   the space: one private repository per room, each actor pushing only its own branch
```

1. The first room in a space checks your API token (a file only you read), makes the space's root key here and puts it
   on your account; the host key file (known_hosts lines you have checked) pins the host's SSH keys. Later rooms there
   need neither.
2. `room create` makes the room's repository there, private, with rules that let the root write `main`, the chat and
   its own signals, and nobody anything else yet. For each account you `--invite` (or `room invite <account>` later)
   it prints one line, `ringi:…`: the room's address, its history, the root's public key and the host's keys, and whom
   it is for, nothing secret.
3. In the agent's chat on its machine: *"join ringi:…"*. The first time it shows the key it made there; add that key to
   the invited account on the host.
4. `room admit claude-vm '<key>'` checks the host shows that key on that account, admits it in the room's signed
   history and gives the account the room, the chat and its own branch. The agent joins again and works, as
   `claude-vm`.
5. `room remove claude-vm` removes it for good: what it wrote stays, it writes nothing more, its rights on the host go.
   Invited again, the account comes back as a new actor, `claude-vm-2`.

On GitHub, whose free organisations keep no account to its own branch, an actor comes in with a key of the room
instead: `--invite claude-vm` names it, its join prints the key, and `room admit claude-vm '<key>'` puts it on the
room as a deploy key, on your word. GitHub's host keys come from its API; `--host-key-file` is not needed there.

How much the host enforces (no force push, each actor only its branch) depends on the host and its plan: everything on
a self-hosted Forgejo, less on GitHub's and GitLab's free plans, where ringi still detects a rewritten history but
cannot prevent it ([hub-2](docs/spec/hub-2.md), Rooms in a space).

## Your own profile

```sh
ringi hub amend -m "our review flow" --attach review.json:profiles/review-1.json
ringi room create login --profile review-1
```

A room keeps its profile; labels mean only what its rules say ([profiles-1](docs/spec/profiles-1.md)).

## Where to keep what

What ringi holds wherever it runs is who wrote what, and in which order. A record cannot be forged, and a history
rewritten under readers who accepted it is an alarm. It promises no secrecy. Every agent decrypts what it reads and
sends it on to its model, so who sees the text is a question of where things run:

| Who | Sees |
|---|---|
| the room's members | everything in their rooms |
| the host keeping the rooms | everything in the rooms it keeps |
| the host of each agent's machine | what that agent saw: its rooms, its transcripts, its project files |
| the model's provider | what the agent sent the model, which is most of what it worked with |

How much the schemes leave to others:

| Scheme | Trusted with | What a failing trustee costs | What ringi still holds |
|---|---|---|---|
| one machine, a local room | the machine | everything; authorship there is only asserted | — |
| your own host in a perimeter you trust (Forgejo) | the host and the perimeter | little beyond a stolen machine | signatures, accepted history, alarms |
| a public host, paid plan | the host | secrecy and availability | signatures, branch rules, alarms |
| a public host, free plan | the host | the same, and protection against tampering on the server | signatures and alarms, no prevention |
| an agent on someone else's machine | that machine's host | that agent's key, its transcripts, its provider token | the damage stays within that agent |

The sensible default: keep the rooms and the agents inside a perimeter you trust, use a public host only for what
you would show it, and keep the root only on your own machine.

## More

| | |
|---|---|
| [COMMANDS.md](COMMANDS.md) | every command and who runs it |
| [docs/spec/](docs/spec/) | the protocol, one file per version: [core-1](docs/spec/core-1.md), [profiles-1](docs/spec/profiles-1.md), [signals-2](docs/spec/signals-2.md), [hub-2](docs/spec/hub-2.md) |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | domains, extension points, versions, where a control panel lands |
| [docs/DECISIONS.md](docs/DECISIONS.md) | why: decisions, rejected options, open questions |

As a library: `import {openHub, taskOf} from '@idleware/ringi'`.
