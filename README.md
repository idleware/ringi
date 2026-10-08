# ringi

**Distributed agent coordinator.**

Orchestrators (Hermes, n8n, OpenClaw) run processes: they decide what happens next. ringi decides nothing of the
kind. It connects the parts, agents of any vendor on one machine or many, and keeps them in sync: who said what to
whom, who took which work, what it may spend, what came of it. Every message is a stored, checkable record; a peer's
message is data, never an instruction.

- **Your rules.** A room's profile defines work and who moves it; A2A tasks are one profile.
- **Budgets.** Proposal, stamps, decision (稟議). The runner spends a grant, never the model.
- **Signals.** Each counted transition gets a checkable marker beside its message (git: a tag).
- **Any store.** Git first; one CLI and a skill for you and the agents.

```sh
npm i -g @idleware/ringi
ringi skill install
```

Node.js 24 or later.

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
4. The agent works on its turn (*"check your inbox"*) or under a watcher: `ringi watch fix-badge/codex --exec …`
   (`--handoff` from its own chat).
5. `ringi where --follow`, `ringi signals`.
6. *"stop"*, *"continue"*, *"leave"* in a chat; `ringi room archive fix-badge` at the end.

Codex: add `~/.ringi` to `writable_roots` in `~/.codex/config.toml`, or approve its escalations.

## Remote: several machines, one hub

```
  laptop: you, the root                    VM 1                               VM 2
  ringi hub create team --signed --url …   ringi hub add team … --root …      ringi hub add team … --root …
  ringi room create fix                    ringi join team fix --as claude    ringi join team fix --as codex
  ringi room admit codex '<key>'           ringi watch team:fix/claude …      ringi watch team:fix/codex …
                  \                                |                                  /
                   any git remote: untrusted storage of signed commits
```

1. `ringi hub create team --signed --url <git url>` prints the `ringi hub add …` line for the other machines.
2. There, `ringi join team fix --as codex` prints the agent's key; you run `ringi room admit codex '<key>' --room fix`.
3. `ringi watch team:fix/codex --require-grant --exec 'codex exec "…"'`

## Your own profile

```sh
ringi hub amend -m "our review flow" --attach review.json:profiles/review-1.json
ringi room create login --profile review-1
```

A room keeps its profile; labels mean only what its rules say ([profiles-1](docs/spec/profiles-1.md)).

## Budgets

```sh
ringi propose -m "Port the parser" --decider operator --reviewers claude --budget runs=5,run-seconds=900
ringi decide <proposal> approved -m "go"           # the approval is a grant
ringi send --task --assign codex --grant <grant> -m "Port the parser"
ringi grants                                       # runs used, open, seconds
```

## More

| | |
|---|---|
| [COMMANDS.md](COMMANDS.md) | every command and who runs it |
| [docs/spec/](docs/spec/) | the protocol, one file per version: [core-1](docs/spec/core-1.md), [profiles-1](docs/spec/profiles-1.md), [decisions-1](docs/spec/decisions-1.md), [signals-1](docs/spec/signals-1.md), [hub-1](docs/spec/hub-1.md) |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | domains, extension points, versions, where a control panel lands |
| [docs/DECISIONS.md](docs/DECISIONS.md) | why: decisions, rejected options, open questions |

As a library: `import {openHub, taskOf} from '@idleware/ringi'`.
