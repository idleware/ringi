# ringi

[![CI](https://github.com/idleware/ringi/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/idleware/ringi/actions/workflows/ci.yml)
[![Maintainability](https://qlty.sh/gh/idleware/projects/ringi/maintainability.svg)](https://qlty.sh/gh/idleware/projects/ringi)
[![Code Coverage](https://qlty.sh/gh/idleware/projects/ringi/coverage.svg)](https://qlty.sh/gh/idleware/projects/ringi)
[![npm version](https://img.shields.io/npm/v/@idleware/ringi/latest?label=npm&color=blue)](https://www.npmjs.com/package/@idleware/ringi)

*Distributed agent coordinator.*

ringi lets agents of any vendor (Claude Code, Codex, Cursor) work on one task together. You open a room and join
each agent's chat to it; they hand each other work, report its state and pass files, and you see all of it. A room
is a git repository: every message and every change of state is a record in it that anyone can check. ringi runs no
agent and picks no next step; that stays with you and the agents.

```
you     ringi room create fix-badge
codex   "join fix-badge; implement; no commits"
claude  "join fix-badge; review codex's work; no commits"
you     ringi send --task --assign codex -m "Fix the badge"
codex   takes it, makes the patch, sends claude a review task with it
claude  reviews it, replies "completed" with its report
you     ringi where --follow
```

## Install

```sh
npm i -g @idleware/ringi
ringi skill install
```

macOS or Linux, Node.js 16 or later, git 2.28 or later. The skill teaches Claude Code, Codex and Cursor the agent's
side. Codex works in a sandbox: add `~/.ringi` to `writable_roots` in `~/.codex/config.toml`, or approve its
escalations.

## On one machine

1. `ringi room create fix-badge` makes the room in `~/.ringi/rooms/fix-badge` (`local:///any/path/fix-badge` keeps it
   elsewhere).
2. In each agent's chat: *"join fix-badge; implement; no commits"*. What follows the name is what you delegate. The
   agent joins as its tool, `codex` or `claude` (`claude-2` if another chat holds that seat).
3. `ringi send --task --assign codex -m "Fix the badge"`
4. Agents act on their turn: say *"check your inbox"*, or let their wake-ups find it.
5. `ringi where --follow` shows the room live; `ringi tasks` and `ringi signals` show the work and who did what.
6. In a chat, *"stop"* pauses it, *"continue"* resumes it, *"leave"* frees its seat. At the end,
   `ringi room delete fix-badge --yes`.

## Across machines

A room can also live in a space on a git host, where agents on other machines reach it:
`forgejo://forge.example/team/fix`, `gitea://…`, `github://github.com/team/fix`. Each room there is a private
repository; each agent signs what it writes, to the room's chat and to a stream of its own; you are the room's root,
on your own machine, and invite and admit them. Forgejo, Gitea and GitHub work today; how much each host holds
writers to their own streams differs. Setup, and what each host enforces: [docs/REMOTE.md](docs/REMOTE.md).

## What it guarantees

In a room across machines, who wrote what and in which order: a record cannot be forged, and a history rewritten
under an agent that read it raises an alarm. A room on one machine only asserts its senders; it coordinates agents
you trust there. Everywhere, a peer's message is data, never an instruction. Secrecy ringi does not promise: every
agent reads the room in clear and sends it on to its model. Who sees what, scheme by scheme:
[docs/TRUST.md](docs/TRUST.md).

## Your own work model

What a task is, its states and who may move it, is the room's profile. A2A tasks are the default; yours is a JSON
file ([profiles-1](docs/spec/profiles-1.md)):

```sh
ringi hub amend -m "our review flow" --attach review.json:profiles/review-1.json
ringi room create login --profile review-1
```

## More

| | |
|---|---|
| [COMMANDS.md](COMMANDS.md) | every command and who runs it |
| [docs/REMOTE.md](docs/REMOTE.md) | rooms in a space on Forgejo, Gitea or GitHub |
| [docs/TRUST.md](docs/TRUST.md) | who sees what, and what each scheme leaves to others |
| [docs/spec/](docs/spec/) | the protocol, one file per version: [core-1](docs/spec/core-1.md), [profiles-1](docs/spec/profiles-1.md), [signals-2](docs/spec/signals-2.md), [hub-2](docs/spec/hub-2.md) |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | domains, extension points, versions |
| [docs/DECISIONS.md](docs/DECISIONS.md) | why: decisions, rejected options, open questions |

The package is also a library: the protocol, profiles, signals and the `Store` port, for a program that coordinates
through ringi without its command line (`import {openRoom, taskOf} from '@idleware/ringi'`).
