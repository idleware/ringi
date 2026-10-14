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
  room deletes it. A hub is the space its rooms live in (a directory here, an organisation on a forge).
- **Your rules.** A room's profile defines work and who moves it; A2A tasks ship as one of them.
- **Streams by meaning.** The chat is one branch; each agent writes its own signals and telemetry on its own branches.
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

## Remote: rooms on a forge

```
  laptop: you, the root                                         VM: an agent
  ringi hub create team --signed --forge forgejo+https://forge/ringi \
    --auth-file ~/forge.token --host-key-file ~/forge.known_hosts
  ringi room create fix --hub team                               "join ringi:… as claude"   (the invitation it printed)
  ringi room admit claude '<key>' --as claude-zurich --room fix  "join ringi:… as claude"   again
                  \                                                     /
                   the forge: one private repository per room, each actor pushing only its own branches
```

1. `ringi hub create team --signed --forge <space> --auth-file <file> --host-key-file <file>` makes the root key
   here, checks your token (a file only you read) and puts the root key on your account there. The host key file
   (known_hosts lines, from the forge's admin or `ssh-keyscan` you check) pins the forge's SSH keys.
2. `ringi room create fix --hub team` makes the room's repository on the forge, private, with branch rules that let
   the root write `main`, the chat and its own streams, and nobody anything else yet; it prints the room's invitation: one line,
   `ringi:…`, with the room's address, its history, the root's public key and the forge's host keys, nothing secret.
3. In the agent's chat: *"join ringi:… as claude"*. The first time it shows the agent's key, made on that machine.
4. `ringi room admit claude '<key>' --as claude-zurich` admits the key in the room's signed history, gives that
   account the room, the chat and claude's own branches, and puts the key on the account (with an admin's token;
   otherwise it says where to add it). The agent joins again and works. An agent never names a hub.

Without a forge, `--url <address>` publishes the contract and a room to a git remote you reach, `git+https://…` or
`git+file://…`, and you give that remote's access yourself. An SSH room comes through `--forge`, which pins the host's
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
