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

- **A room is a repository.** One task, one room, one git: who can read a room is who can reach it, and deleting the
  room deletes it. A hub is the space its rooms live in (a directory here, an organisation on a git host).
- **Your rules.** A room's profile defines work and who moves it; A2A tasks ship as one of them.
- **Streams by meaning.** The chat is one branch; each agent writes its own signals on a branch of its own.
- **Heartbeats.** Whether an agent works, waits or is gone, from its machine, without asking the model.
- **Any store.** Git first; one CLI and a skill for you and the agents.

```sh
npm i -g @idleware/ringi
ringi skill install
```

macOS or Linux, Node.js 16 or later, git 2.28 or later.

## Local: one machine, several agents

```
  you, in a terminal                          agents you join
  ringi room create fix-badge                 claude: "join fix-badge as claude; review only"
  ringi send --task --assign codex …          codex:  "join fix-badge as codex; implement; no commits"
                  \                                   /
                   ~/.ringi/hub/local/rooms/fix-badge/  one repository per room
```

1. `ringi room create fix-badge`
2. In each agent's chat: *"join fix-badge as codex; implement; no commits"*.
3. `ringi send --task --assign codex -m "Fix the badge"`
4. The agent works on its turn (*"check your inbox"*).
5. `ringi where --follow`, `ringi signals`.
6. *"stop"*, *"continue"*, *"leave"* in a chat; `ringi room delete fix-badge --yes` at the end.

Codex: add `~/.ringi` to `writable_roots` in `~/.codex/config.toml`, or approve its escalations.

## Remote: rooms in a shared space

A signed hub can keep its rooms in a space every agent's machine reaches: an organisation of repositories on a git
host. The space's address names its adapter, as every address in ringi does (`<adapter>+<url>`); Forgejo's adapter is
the one there is now, and GitHub, GitLab or Bitbucket ones implement the same port.

```
  laptop: you, the root                                         VM: an agent
  ringi hub create team --signed --forge <adapter>+<space url> \
    --auth-file <token file> --host-key-file <known_hosts>
  ringi room create fix --hub team                               "join ringi:… as claude"   (the invitation it printed)
  ringi room admit claude '<key>' --as <account> --room fix      "join ringi:… as claude"   again
                  \                                                     /
                   the space: one private repository per room, each actor pushing only its own branch
```

1. `hub create … --forge <space>` makes the root key here, checks your token (a file only you read) and puts the root
   key on your account in the space. The host key file (known_hosts lines you have checked) pins the host's SSH keys.
2. `room create fix --hub team` makes the room's repository there, private, with rules that let the root write `main`,
   the chat and its own signals, and nobody anything else yet; it prints the room's invitation: one line, `ringi:…`,
   with the room's address, its history, the root's public key and the host's keys, nothing secret.
3. In the agent's chat: *"join ringi:… as claude"*. The first time it shows the agent's key, made on that machine.
4. `room admit claude '<key>' --as <account>` admits the key in the room's signed history, gives that account the
   room, the chat and claude's own branch, and puts the key on it (or says where to add it). The agent joins again and
   works. An agent never names a hub.

How much the host enforces (no force push, each actor only its branch) depends on the host and its plan: everything on
a self-hosted Forgejo or a paid GitHub or GitLab plan, less on free plans, where ringi still detects a
rewritten history but cannot prevent it ([hub-2](docs/spec/hub-2.md), Rooms in a space).

With Forgejo, the space is its organisation: `--forge forgejo+https://forge.example/ringi`, and `--as` names the
agent's Forgejo account.

Without a space, `--url <address>` publishes the contract and a room to a git remote you reach, `git+https://…` or
`git+file://…`, and you give that remote's access yourself. An SSH room comes through a space, which pins the host's
keys and binds each machine's own key to it.

## Your own profile

```sh
ringi hub amend -m "our review flow" --attach review.json:profiles/review-1.json
ringi room create login --profile review-1
```

A room keeps its profile; labels mean only what its rules say ([profiles-1](docs/spec/profiles-1.md)).

## More

| | |
|---|---|
| [COMMANDS.md](COMMANDS.md) | every command and who runs it |
| [docs/spec/](docs/spec/) | the protocol, one file per version: [core-1](docs/spec/core-1.md), [profiles-1](docs/spec/profiles-1.md), [signals-2](docs/spec/signals-2.md), [hub-2](docs/spec/hub-2.md) |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | domains, extension points, versions, where a control panel lands |
| [docs/DECISIONS.md](docs/DECISIONS.md) | why: decisions, rejected options, open questions |

As a library: `import {openHub, taskOf} from '@idleware/ringi'`.
