# Architecture

**Purpose.** A coordinator, not an orchestrator: ringi connects agents and keeps them in sync (messages, who took
which work, what it may spend, what came of it); the next step is never its call. Every choice below is judged by
whether that stays auditable, verifiable and as secure as is reasonable.

ringi is a protocol and its implementation. Both will change: the protocol gains capabilities and
majors, the coordinator gains stores, interfaces and maybe another language. So the specs are versioned apart from
the code, the code is split into domains with one direction of dependency, and every point of variation is a
registry or data, never an edit across the tree.

## Domains

| Domain | `src/main/ts/` | Owns | Imports |
|---|---|---|---|
| lib | `lib/` | errors, strict JSON, atomic files, file locks, the sandbox write guard, formatting | Node only |
| protocol | `protocol/` | message text and trailers, attachable paths, threads and order, delivery ([core-1](spec/core-1.md)) | lib |
| domain | `domain/` | pure folds over messages, one module per capability: `profiles` (what work is), `decisions` (proposals, grants, usage), `signals` (signals and marks); `index` registers them | protocol, lib |
| store | `store/` | the `Store` port; adapters `git` (local and signed), `kafka` and `temporal` (planned, registered) | protocol, lib |
| home | `home/` | this machine's directory: paths, terminal context, locks, migrations | lib |
| hub | `hub/` | descriptor, contract, rooms, the write path (append, control changes, signals) | domain, store, home, protocol, lib |
| runtime | `runtime/` | sessions and seats, what each reader accepted, the watcher | hub and below |
| app | `app/` | use cases, one function per operation, typed input and output, no printing: `context` (who acts), `room` (messages, work, signals), `budget`, `hubs`, `rooms`, `overview`, `agent` and `session` (turns, seats, the watcher), `view` (text and JSON shapes) | runtime and below |
| interfaces | `cli/` (the entry is `cli.ts`), `panel/` (planned), the skill in `src/main/resources/skill/` | parse, call `app`, render | app, lib |

`index.ts` is the library: protocol, domain, store port and hub. Each domain imports only itself and the domains in
its row. Type-only imports carry no behaviour and may point anywhere. `src/test/ts/layers.test.ts` checks the rule on
every build. `domain` does no I/O. `store` checks structure (ids, text, signatures, ancestry, a room's name and roster) but folds
no work, profile or budget. Nothing below the interfaces writes stdout (stderr notes and alarms excepted).

## Extension points

| To add | Do | Touch nothing else |
|---|---|---|
| a store type | implement `Store` in `store/<type>/`, register it in `STORES` | hubs name it in `hub.json` |
| a work model | write a profile (`ringi-profile/1`), attach it to the hub | no code |
| a capability, or a new major of one | a module in `domain/` exporting its id (`decisions/2`), registered in `CAPABILITIES`; for a second major, also the dispatch to it (planned: hub, app and runtime call the folds of the major the room's contract selects) | the old major stays beside it |
| an interface (control panel, MCP, HTTP API) | an adapter over `app/` | never reads the store or the home directly |
| an agent runtime | `ringi watch --exec '<any CLI>'` | no code |

## The control panel (planned)

It lands in `src/main/ts/panel/` as another interface: `ringi panel` serves a local page and a JSON API on
localhost. Every call maps to one `app` operation: queries (hubs, rooms, sessions, tasks, a thread, signals,
proposals, grants) and the operator's commands (send, assign, decide, stop, continue, archive). It acts as the
operator of this machine, as the terminal does. Live updates come from `app` (the store is polled; a store may
notify, core-1 §2). A panel for several machines is a later interface over the same `app`, authenticated by the
signed hub's keys.

## Evolution

| What | Version | Declared in | Rule |
|---|---|---|---|
| protocol core | `1` | contract `protocol` | a reader refuses an unknown major |
| capability | `<name>/<major>` | contract `capabilities` | see below |
| hub contract | `1.x` | `contract.json` `version` | a minor only adds optional data without authority; a major is refused by older readers |
| hub descriptor | `ringi-hub/2` | `hub.json` `schema` | read the previous schema, write the current |
| profile | `ringi-profile/1` | the profile's `schema` | a room keeps the profile it was made with |
| home | `3` | `home.json` | migrated in place on first use (`home/`) |
| package | semver | `package.json` | `ringi --version` names the majors it reads |

- **Capabilities.** A contract lists the capabilities its rooms need, at most one major of each name. The registry
  holds what this build enforces; a contract that lists an id the build does not register, or two majors of one
  name, is refused. With one major of each today, hub, app and runtime call it directly; routing each room to the
  major its contract base selects comes with the first second major. A room moves to another major only by an
  explicit `room rebase-contract`.
- **Specs are files per major.** `docs/spec/<name>-<major>.md`. A new major is a new file; the old one stays as long
  as code reads it. A minor edits the file and says what it added.
- **Code mirrors specs.** Each spec has one module that implements it and names it in its first line.
- **Fail closed.** Unknown majors and capabilities are refused with the version needed; nothing that grants or
  restricts is ever ignored.
- **Migrations are code with a test.** Local state migrates on first use; shared state moves only by an explicit
  operator command (`hub amend`, `room rebase-contract`).

## Portability

ringi will likely be rewritten in Go or Rust, so as not to need Node. It stays small enough to port by reading it.

- Behaviour lives in [spec/](spec/); the code mirrors it. Whatever exists only in code is a gap to close.
- No runtime dependencies: Node's standard library, the `git` binary and the OS. Nothing in the home or a hub depends
  on Node.
- Formats are message text with trailers and small JSON files; no protobuf, gRPC or binary encodings in the core.
  Anything heavier is an optional adapter.
- Tests that go through the command line (`flow`, `ringi`, `model`) are a conformance suite for any implementation:
  `RINGI_BIN=<executable> npm run test:conformance` runs them against it (`src/test/ts/cli.ts`). `node.test.ts`, `remote.test.ts` and
  `layers.test.ts` test this implementation.
- What a port would still have to read from the code is listed in [DECISIONS.md](DECISIONS.md) (Porting gaps).

## Documentation

| File | Reader | Holds |
|---|---|---|
| `README.md` | users | what ringi is, install, the local and the remote flow |
| `COMMANDS.md` | users, agents | every command and who runs it, generated from the command table |
| `docs/ARCHITECTURE.md` | contributors | this page |
| `docs/spec/core-1.md`, `profiles-1.md`, `decisions-1.md`, `signals-1.md`, `hub-1.md` | implementers | the normative specs |
| `docs/DECISIONS.md` | everyone | why: dated decisions, rejected options, open questions |
| `src/main/resources/skill/ringi/SKILL.md` | agents | how an agent takes part |
