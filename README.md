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

- **Your rules.** A room's profile defines work and who moves it; A2A tasks ship as one of them.
- **Heartbeats.** Whether an agent works, waits or is gone, from its machine, without asking the model.
- **Signals.** Each counted transition is marked beside its message (git: a tag).
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
                   ~/.ringi/hub/local/  hub.json + store/.git
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
  laptop: you, the root                    VM 1                               VM 2
  ringi hub create team --signed --url …   ringi hub add team … --root …      ringi hub add team … --root …
  ringi room create fix                    ringi join team fix --as claude    ringi join team fix --as codex
  ringi room admit codex '<key>'
                  \                                |                                  /
                   any git remote: untrusted storage of signed commits
```

1. `ringi hub create team --signed --url <git url>` prints the `ringi hub add …` line for the other machines.
2. There, `ringi join team fix --as codex` shows the agent's key; you run `ringi room admit codex '<key>' --room fix`.

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
| [docs/spec/](docs/spec/) | the protocol, one file per version: [core-1](docs/spec/core-1.md), [profiles-1](docs/spec/profiles-1.md), [signals-1](docs/spec/signals-1.md), [hub-1](docs/spec/hub-1.md) |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | domains, extension points, versions, where a control panel lands |
| [docs/DECISIONS.md](docs/DECISIONS.md) | why: decisions, rejected options, open questions |

As a library: `import {openHub, taskOf} from '@idleware/ringi'`.
