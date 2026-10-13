# Architecture

**Purpose.** A coordinator, not an orchestrator: ringi connects agents and keeps them in sync (messages, who took
which work, what came of it); the next step is never its call. Every choice below is judged by
whether that stays auditable, verifiable and as secure as is reasonable.

ringi is a protocol and its implementation. Both will change: the protocol gains capabilities and
majors, the coordinator gains stores, interfaces and maybe another language. So the specs are versioned apart from
the code, the code is split into core, adapters and clients with one direction of dependency, and every point of variation is
a port with its adapters, a registry or data, never an edit across the tree.

## Domains

The tree has three roles, each a future package: `core/` is what ringi is, `adapters/` are the ways it meets the world
(a store, this machine's state and processes, an agent tool, a key), `clients/` are its interfaces. `composition/` alone
puts them together when a program starts; nothing else imports an adapter. Core asks for what it needs through ports
(`hubPorts()`, `agentPorts()`), each beside the context that owns the need.

| Domain | `src/main/ts/` | Owns | Imports |
|---|---|---|---|
| lib | `lib/` | helpers that know nothing of ringi: errors (`Fail`, `WriteDenied`), notes (sent where composition says), strict JSON, formatting; no host | nothing |
| hub | `core/hub/` | the coordination ([hub-2](spec/hub-2.md)): `protocol` (messages, threads, order, delivery; [core-1](spec/core-1.md)), `rooms` (descriptor, contract, members, quorum, the write path), `work` ([profiles-1](spec/profiles-1.md)), `signals` ([signals-2](spec/signals-2.md)), `history` (what each reader accepted: heads, pins, alarms), `usecases` (one function per operation, typed input and output, no printing), `ports` (`Store` and `Transport`, `LocalState`) | lib |
| agents | `core/agents/` | agents on this machine: `sessions` (bindings and seats), `heartbeat` (working, waiting or gone, from facts alone; the pulse), `ports` (`AgentTool`, `ProcessHost`) | hub, lib |
| signing | `core/signing/` | `Signer`: a key's public identity and a signature over exact bytes, apart from where the key is kept | lib |
| adapters | `adapters/<type>-<name>/`, the type being what it is to ringi | `store-git` (local and signed), `agent-claude`, `agent-codex`, `agent-cursor`, `keys-file`, `host-posix` (macOS, Linux), `state-fs` (`$RINGI_HOME`); shared: `fs` (files, locks), `agent-traces` | core, the shared adapters, lib |
| clients | `clients/cli/` (the entry is `cli.ts`), `clients/panel/` (planned) | parse, call core's use cases, render. The command line is one for both: `operator/` (as the operator), `agent/` (`ringi agent …`, as the agent a session is bound to), `shared/` (under both), `skill/` (installs the skill: the agents' manual for this same command line, `src/main/resources/skill/`, where each agent tool reads skills) | hub, agents, lib |
| composition | `composition/` | this build and which adapters | everything |

`index.ts` is the library; importing it wires the defaults through composition. Every import counts, type-only ones
and re-exports too: `src/test/ts/layers.test.ts` checks the rule on every build, and that `lib`, `protocol`, `work`,
`signals` and `signing` touch no host (no `node:` module, no `process`). Time is not behind a port yet: a
fold may default `now` to the clock, and `lib` may wait and date. A store checks
structure (ids, text, signatures, ancestry, a room's name and roster) but folds no work or profile. Nothing
but the clients writes stdout; notes and alarms go where composition sends them (stderr). On an asserted hub nothing
is signed: signing exists for signed hubs only, and the rules of an asserted hub (roles, quorum) coordinate honest
agents rather than protect against a writer.

## Extension points

| To add | Do | Touch nothing else |
|---|---|---|
| a store type (Kafka topics, a Telegram group, …) | implement `Store` and its `Transport` in `adapters/store-<name>/`, register it in composition, and run `storeContract` (`src/test/ts/store-contract.ts`) over it | hubs name it in `hub.json`; what a store must guarantee is in [hub-2](spec/hub-2.md) |
| an agent tool | implement `AgentTool` in `adapters/agent-<name>/` (recognise a session, its trace, where it reads skills, its sandbox), list it in composition | sessions, heartbeat and the skill installer ask the tools |
| an operating system | implement `ProcessHost` in `adapters/host-<name>/`, choose it in composition | heartbeat asks the host |
| a place for keys (an SSH agent, 1Password, a hardware key) | implement `Signer` in `adapters/keys-<name>/`, give it to the signed transport in composition | asserted hubs never ask |
| a work model | write a profile (`ringi-profile/1`), attach it to the hub | no code |
| a capability, or a new major of one | a module in `core/hub/` exporting its id (`profiles/2`), registered in `CAPABILITIES`; for a second major, also the dispatch to it | the old major stays beside it |
| an interface (control panel, MCP, HTTP API) | a client over core's use cases | never reads a store or the machine's state directly |

A signed Git store signs only through its injected `Signer` and verifies each signature before a ref moves; key
files are `keys-file`'s alone.

## The control panel (planned)

It lands in `src/main/ts/clients/panel/` as another client: `ringi panel` serves a local page and a JSON API on
localhost. Every call maps to one use case of core: queries (hubs, rooms, sessions, tasks, a thread, signals)
and the operator's commands (send, assign, stop, continue, delete). It acts as the
operator of this machine, as the terminal does. Live updates come from core (the store is polled; a store may
notify, core-1 §2). A panel for several machines is a later client over the same use cases, authenticated by the
signed hub's keys.

## Evolution

Every format that can change has a gate: a version, checked in one place, that refuses what this build cannot read
and says what to do. ringi migrates nothing. A hub it cannot read stays as it is; the operator makes a new hub beside
it (`ringi hub create local2`) or a new space on a forge. A home it cannot read stays too; a new `RINGI_HOME`
starts fresh. A migration, if one is ever worth it, is a tool beside ringi that reads the old format and writes the
new; ringi never imports it.

| What | Version | Declared in | Gate |
|---|---|---|---|
| protocol core | `1` | contract `protocol` | `core/hub/rooms/compat.ts`: another major is refused |
| capability | `<name>/<major>` | contract `capabilities` | `compat.ts`: an id this build does not register is refused (see below) |
| hub contract | `2.x` | `contract.json` `version` | `compat.ts`: another major is refused; a minor only adds optional data without authority |
| store layout | `git/3` | contract `store` | `compat.ts`, when a hub or a room's store opens, against `Transport.layout` |
| hub descriptor | `ringi-hub/3` | `hub.json` `schema` | `compat.ts`: another schema is refused |
| profile | `ringi-profile/1` | the profile's `schema` | a room keeps the profile it was made with |
| home | `4` | `home.json` | `adapters/state-fs`: another version is refused; a change to any durable record (config, readers, sessions, descriptors) is a new version |
| package | semver | `package.json` | `ringi --version` names the majors it reads |

- **Capabilities.** A contract lists the capabilities its rooms need, at most one major of each name. The registry
  holds what this build enforces; a contract that lists an id the build does not register, or two majors of one
  name, is refused. With one major of each today, the hub and the agents call it directly; routing each room to the
  major its contract selects comes with the first second major. A room never moves to another contract: a new one
  is a new room.
- **Specs are files per major.** `docs/spec/<name>-<major>.md`. A new major is a new file; the old one stays as long
  as code reads it. A minor edits the file and says what it added.
- **Code mirrors specs.** Each spec has one module that implements it and names it in its first line.
- **Fail closed.** Unknown majors and capabilities are refused with the version needed; nothing that grants or
  restricts is ever ignored.
- **Gates, not migrations.** A format that changes gets a new version at its gate (above); old state is refused with
  what to do, never migrated in place. A gate protects only readers that know it: a layout older ringi cannot read
  also raises the contract major, which every ringi checks. Markers of running processes (locks, the pulse's pid)
  carry no version; changing one means stopping that process once. Shared state moves only by an explicit operator command (`hub amend`).

## Portability

ringi will likely be rewritten in Go or Rust, so as not to need Node. It stays small enough to port by reading it.

- Behaviour lives in [spec/](spec/); the code mirrors it. Whatever exists only in code is a gap to close.
- No runtime dependencies: Node's standard library, the `git` binary and the OS. Nothing in the home or a hub depends
  on Node.
- Formats are message text with trailers and small JSON files; no protobuf, gRPC or binary encodings in the core.
  Anything heavier is an optional adapter.
- Tests that go through the command line (`flow`, `ringi`, `model`) are a conformance suite for any implementation:
  `RINGI_BIN=<executable> npm run test:conformance` runs them against it (`src/test/ts/cli.ts`). `node.test.ts`, `remote.test.ts`, `host.test.ts`, `signer.test.ts`, `compat.test.ts`, `store.test.ts` and
  `layers.test.ts` test this implementation.
- What a port would still have to read from the code is listed in [DECISIONS.md](DECISIONS.md) (Porting gaps).

## Documentation

| File | Reader | Holds |
|---|---|---|
| `README.md` | users | what ringi is, install, the local and the remote flow |
| `COMMANDS.md` | users, agents | every command and who runs it, generated from the command table |
| `docs/ARCHITECTURE.md` | contributors | this page |
| `docs/spec/core-1.md`, `profiles-1.md`, `signals-2.md`, `hub-2.md` | implementers | the normative specs |
| `docs/DECISIONS.md` | everyone | why: dated decisions, rejected options, open questions |
| `src/main/resources/skill/ringi/SKILL.md` | agents | how an agent takes part |
