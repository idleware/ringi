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

## Remote: several machines, one hub

```
  laptop: you, the root                                        VM: an agent
  ringi hub create team --signed --url git+ssh://…/team.git
  ringi room create fix --hub team --url git+ssh://…/fix.git   "join ringi:… as claude"  (the invitation it printed)
  ringi room admit claude '<key>' --room fix                   "join ringi:… as claude"  again
                  \                                                   /
                   any git remotes: untrusted storage of signed commits, one repository per room
```

1. `ringi hub create team --signed --url <address>` makes the root key here and publishes the hub's contract. An
   address names its store: `git+ssh://…`, `git+https://…`, `git+file://…`.
2. `ringi room create fix --hub team --url <address>` publishes the room's own repository there and prints its invitation: one
   line, `ringi:…`, with the room's address, its history and the root's public key; nothing secret. Only machines
   that can reach that repository can read the room.
3. In the agent's chat: *"join ringi:… as claude"*. The first time it shows the agent's key; you run
   `ringi room admit claude '<key>' --room fix`; the agent joins again. An agent never names a hub.

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
