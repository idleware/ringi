# Decisions

Why ringi is the way it is: the problem, what others do, what we tried, what we decided and rejected, what is open,
and the dated log of experiments and corrections. Normative text lives in [spec/](spec/); the shape of the code in
[ARCHITECTURE.md](ARCHITECTURE.md); earlier drafts are kept in `docs/history/` in the source checkout.

## The problem

Agents from different vendors run on different machines. Most of them are not daemons but sessions that start, think and stop. They need to:

- know who is speaking;
- leave messages for someone who is offline;
- pass files;
- hand off tasks and see their state;
- wake each other up without burning each other's quota;
- not obey each other blindly.

## What others do (checked 2026-10-03)

**Service protocols** assume reachable endpoints and peers that are online.

- [A2A](https://a2a-protocol.org/latest/specification/) v1.0, released in March 2026 and now under the Linux Foundation's AAIF:
  - an Agent Card at `/.well-known/agent-card.json`, signed with JWS;
  - Tasks with the states submitted, working, input-required, auth-required, completed, failed, canceled, rejected;
  - JSON-RPC, gRPC or HTTP+JSON, with webhook push;
  - custom protocol bindings are allowed.
- [MCP](https://modelcontextprotocol.io), spec 2026-07-28, connects an agent to tools, not to other agents. It went stateless, moved tasks into an extension and deprecated sampling.
- [ANP](https://agent-network-protocol.com): `did:wba` identities, prekey bundles to reach offline peers, MLS for groups.
- [AGNTCY SLIM](https://spec.slim.agntcy.org/draft-mpsb-agntcy-slim.html): MLS-encrypted messages through untrusted gRPC relays; no store-and-forward.

**Coordination tools for coding agents** work on one machine or around one central store. Identity is just a name string.

- [MCP Agent Mail](https://github.com/Dicklesworthstone/mcp_agent_mail): a server; markdown messages archived in git and indexed in SQLite; advisory file leases.
- [beads](https://github.com/gastownhall/beads) and Gas City: work items and mail live in Dolt, synced over a git remote; claims are atomic; tmux nudges wake agents.
- Claude Code:
  - [agent teams](https://code.claude.com/docs/en/agent-teams): a JSON mailbox per agent and a shared task list;
  - [cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging): a socket inbox per session, relayed through Anthropic between machines. A peer's message never counts as user consent.
- GitHub Agent HQ: issues and PRs serve as the bus.

**Signed logs** give strong identity and replication. Nothing built on them for agents is still standing.

- Nostr: the NIP-90 job market is marked unrecommended; activity moved to MCP over Nostr (ContextVM).
- Radicle keeps per-peer signed refs and collaborative objects in git. In 2026 its [sigrefs replay](https://radicle.dev/2026/03/30/disclosure-of-vulnerability-in-signed-references) bug rolled peers back: an attacker wrapped an old signed state in a new commit. The fix binds each signature to its parent.
- git-bug, AT Protocol and SSB belong to the same family.

**Gaps nobody covers:**

- waking agents that run as sessions;
- offline store-and-forward without a dedicated server;
- signed, content-addressed assets;
- identity that needs no server and supports rotation;
- log integrity: rollback and fork detection;
- claims over replicated logs;
- injection between agents (OWASP ASI07).

Git covers several of these by construction. That is the bet here.

## What we tried before

- **The file channel**: numbered, immutable files with fixed parity (codex odd, claude even). Lessons:
  - never edit a sent message;
  - parity collisions still happen;
  - one-shot watchers die silently;
  - a turn-based peer needs a fresh trigger for every batch of work.
- **The zurich task contract**:
  - a task is a directory with `TASK.md` and assets;
  - the runner writes `status.json` and `REPORT.md`, not the model;
  - a run starts only on an explicit push;
  - budget fuses, no automatic retries.
- **The amster Forgejo bus**: a branch per task and a log per host. Branch protection enforces a single writer per branch. Trigger and retention stayed unsolved.

## Decisions

1. **One log per agent, one writer.** A shared branch races with constant non-fast-forward pushes; amster showed that. Per-agent logs need no coordination: every push fast-forwards, and replicas merge as a plain union.
   - Since v0.2, every log starts from the network genesis, the root commit of `main`.
   - In v0.1 they were orphan branches. The operator's question "no common ancestor, so the branches hang in the air?" exposed two costs:
     - git and forge tools saw unrelated histories;
     - a log could be replayed into another network where the same key is admitted. Delivery is by id, so `To: bob` would reach a different bob there.
   - One parent link fixes both.
2. **A message is a commit, not a file.** Id, parent link, time, signature and attachments come built in. Any git client can write a message, and `git log` reads them.
3. **Attachments are the commit's diff over a cumulative tree.** (Superseded 2026-10-11: an identical file attached
   again was lost; the store now lists attached paths, [hub-1](spec/hub-1.md).)
   - The head tree is the agent's published folder, browsable in any forge UI.
   - Each commit's diff shows exactly what that message carried.
   - Successive versions of an artifact are successive commits.
4. **Trust is git's own `allowed_signers` file, kept on `main` and signed by a pinned root.**
   - Admission and revocation are commits by the operator.
   - `valid-before` keeps old messages verifiable after a key rotation. Git checks it against the committer time (verified on git 2.54), so on its own it can be backdated around.
   - Since v0.1, `main:frozen` pins every retired key to the last commit it may sign. That closes backdating without trusting any clock.
5. **Readers only fast-forward.** Rollback is impossible, rewrites and equivocation raise alarms, and nothing unverified ever reaches a model.
6. **Tasks are folded from trailers, using A2A's state names.** (Superseded 2026-10-11: states and rights come from
   the room's profile, [profiles-1](spec/profiles-1.md); A2A is the profile `a2a-1`.) No server holds task state; any replica can recompute it.
   - Only the requester can cancel, and only assignees move the state.
   - Since v0.1, assignment comes from the requester's `Assign:`. A first-claim rule is unstable across replicas; a single writer's order is not.
7. **The receiver decides when it wakes.** A sender can't spend the receiver's quota.
   - Depth along the `Re` chain breaks ping-pong between agents. The declared `Hop` can only raise that depth, never lower it.
   - The run budget persists across runs.
8. **Verified is not obeyed.** A signature answers "who sent this", never "should I do it".
9. **Joining: keys stay where they are used; the root admits them** (v0.3, settled with the operator).
   - A first version had the root generate key pairs and ship them in bundles. Codex objected and the operator agreed: a private key that travels lands in bundles and backups.
   - Now the agent generates its key, and the operator takes the public key over the provisioning channel.
   - The root admits it into the roster on `main`, which is the truststore.
   - The agent's own anchors, the root key and the genesis, come from the operator in an invitation, never from a hub.
10. **Hubs are untrusted replicas** (v0.3, the operator's "imagine the hosting admin wiped the machine").
    - Nothing on a hub needs trust: content is signed by keys that live elsewhere.
    - Least privilege: an agent writes only its own log, only the root writes `main`, read access is per room. One compromised agent no longer reaches everything.
    - Readers remember what each hub served; owners and the root repair hubs from their replicas.
    - A root-issued hub member seals the heads after every push. A wipe loses the hub's key with its data, so the hub cannot vouch for itself again until the root reissues it.
11. **Rooms.** A room is one hub repository with its own roster and genesis; group discussions are threads inside it. The protocol was always many-to-many: one log per writer, everyone reads, `To` says who is expected to act.

**Rejected:**

- A shared branch per conversation: it races.
- A message as a file: diffs fill up with unrelated files, and writing a message takes more ceremony.
- Merge parents as read receipts: other agents' commits show up in your branch in a forge UI, and plain git gets harder to use.
- Nostr or HTTP transports: they need relays or endpoints, while git remotes already exist and work offline.

## Experiments

### 2026-10-03

- **Spike: SSH signing in git.**
  - SSH-signed commits via `commit-tree -S` work in bare repos.
  - `%G?` is `G` only when the principal is listed in `allowed_signers`. It is `U` for unknown or expired keys. `%GS` is the principal.
  - `valid-before` is checked against the committer date, so backdating a commit evades revocation (SPEC §10).
- **`--trailer` gotcha.** `git commit --trailer` and the default cleanup treat `# Heading` lines as comments, so the trailers landed above a markdown heading.
  - For plain git, the fix is `--cleanup=verbatim -F file` with the trailers written into the file.
  - The client uses `commit-tree`, which takes the text verbatim.
- **Tests (v0).** `node --test` ran 11 end-to-end checks, all passing:
  - a task round trip with files;
  - a third party can't move a task;
  - a forged signature on another agent's log is rejected;
  - a rewritten log raises an alarm;
  - an unknown agent stays pending and unseen;
  - a tampered roster is rejected;
  - a revoked key keeps its past and loses its future;
  - plain git interoperates with the client;
  - control characters are refused;
  - the hop limit stops two bots that answer everything: the exchange halts at `Hop: 3` with `--max-hop 3`, since the limit is exclusive ("below", SPEC §9);
  - `wait` times out.
- **`watch --once`.** One pass per timer tick or hub webhook keeps zurich's invariant: nothing polls on its own, and waking stays explicit and budgeted.
- **Waking in practice.** The codex collaboration began on the old file channel, which was itself moved once mid-flight.
  - My first message landed in the abandoned directory.
  - After the resend, codex stayed idle for over 30 minutes: it is turn-based, and nothing in a file channel wakes it.
  - This is the gap §9 targets. Delivery alone is not enough; something on the receiver's side must turn "a message arrived" into "a turn starts", within a budget.
- **Control characters.** ESC and other control characters in a message are a validity error. Otherwise a peer could drive the operator's terminal.
- **Blind second implementation (codex, OpenAI).** Codex got only SPEC v0 and NOTES. In about an hour it produced a Python client of ~500 lines with 20 tests (`clients/codex/`) and joined the lab.
  - The out-of-band step worked: the fingerprint codex reported in the file channel matched the key `admit --from-log` found on its first commit.
  - Interop is bidirectional. My client accepts codex's signed card and its `State: working` reply; codex's client accepts my roster, log, task and attachment.
  - The task itself went over the room: the decisions file as an attachment, the status as trailers. The file channel only triggers codex's turns.
- **What codex's review found in v0.** 14 ambiguities, plus attacks it reproduced:
  - backdating past `valid-before`;
  - a later-delivered claim with an earlier timestamp stealing an open task;
  - a reply completing both a nested task and its parent;
  - a `Hop: 0` reset;
  - a symlink attachment pointing at `/etc/passwd`.

  All are fixed in v0.1 (SPEC "Changes"). It also caught two places where my client contradicted SPEC's own wording: an inclusive hop limit, and terminal states that could still change. Spec wording is the implementation; a second implementation is the cheapest way to read it literally.
- **Kahn order and causality.** One new v0.1 test was flaky: the assignee answered the task rather than the `Assign` message. Within the same second, the sha decided that the work came before the assignment.
  - Only explicit links order messages across logs; clocks only break ties.
  - Rule added to SPEC §6: to act on a message, answer that message.
- **git and non-UTF-8 messages.** `commit-tree -S` transcodes a non-UTF-8 message after signing it, so such commits always verify as `B`. The UTF-8 rule still matters for writers other than git; the test builds that commit byte by byte and signs it with `ssh-keygen`.
- **Tests (v0.1).** 15 end-to-end checks, all passing. On top of v0's:
  - the root itself cannot drop a key;
  - a backdated message after revocation is refused by the freeze;
  - malformed trailers route nowhere;
  - symlinks are refused;
  - C1 controls and invalid UTF-8 are refused;
  - a `Hop: 0` reset still counts as deep;
  - nested tasks stay separate;
  - open tasks wait for `Assign`;
  - the run budget survives one-shot runs without losing messages;
  - ids that can't be branch names are refused.

- **v0.2, from codex's v0.1 report and the operator's question:**
  - logs start from the genesis;
  - a new freeze cuts history a replica accepted past the anchor. Warm and fresh replicas converge, and a rotated key's continuation is not a fork;
  - `Assign` takes effect step by step;
  - the effective hop is monotonic.
- **Tests (v0.2).** 18 end-to-end checks, all passing, including:
  - a freeze cuts a warm replica back to the anchor, and a fresh replica lands on the same head;
  - a log relayed into a second network, with the same key admitted there, is rejected as "not rooted at the network genesis";
  - the plain-git recipe from the appendix starts a log correctly.
- **Lab reset for v0.2.**
  - The orphan logs moved to `refs/heads/archive/v0.1/`; nothing was deleted.
  - The genesis, roster and admissions stayed.
  - The hub's `main` now carries SPEC v0.2: a roster commit may change files other than `allowed_signers` and `frozen` freely.
  - `git log --graph --all` on the hub now draws a tree rooted at the genesis.

- **v0.3: credentials, hubs, rooms.** Root-issued bundles (`issue`, `init --bundle`), hub seals, per-hub memory, owner-and-root repair. 21 end-to-end checks pass. The new scenario runs:
  1. the hosting admin rolls a log back; the seal and the replica's memory both catch it, and the root's replica repairs it;
  2. the admin wipes the machine, the hub's key included. Replicas report the loss: the agent restores its log, the root restores the roster and the rest;
  3. the root reissues the hub member's key, and sealing continues on the restored seal log without a single alarm.

### 2026-10-07

- **Two stories.** The operator split the work: the message protocol ([spec/core-1.md](spec/core-1.md)) and its bindings. The local binding (the former directory binding) is what the operator needs now: agents of different vendors on one machine, access controlled by the operator, no keys.
- **PROTOCOL v1 review.** Gaps found on a re-read: no room term, sender taken from text, time not required of bindings, one-writer logs contradicting the shared task branch, two validity classes mixed. All fixed; decisions on limits and waking taken from the agent's point of view (context and quota are the scarce resources; `To: *` never wakes).
- **Local binding, atomicity.** The first layout (`000007.md` plus `000007/`) needed two renames and was not atomic for two processes of one agent. A directory per message with one `rename` is: a rename cannot replace a non-empty directory, so the loser gets an error and takes the next number. 20 concurrent writers get gapless numbers in the test.
- **One core.** `core.mjs` now holds the protocol; the git client imports it, and the local binding is 400 lines on top. Both suites pass (21 + 9).
- **Seats.** The first instructions block told every session to read the inbox at start. The operator caught it: with several sessions per project, that is N readers on one at-most-once queue, stealing each other's messages. Now exactly one session per agent id is designated (it takes a seat), bound to the UI's process id found in the command's ancestry, so a closed session frees its seat by itself. The instructions block only says that the room exists and that non-designated sessions must ignore it.
- **Delegation and heartbeats.** The first live exchange over the room caught two things. Codex refused the task because designation named *who* it was, not *what* the operator delegated: the skill now treats designation as delegation with a recorded scope. And "wait 110 s, three times, then give up" is the wrong waiting protocol for agents: the operator asked for a diverging interval or a ping/pong. Both are in: heartbeats keep a peer's `wait` alive and get a pong from the waiting *process*, so a long job costs no model turns on either side; silence without heartbeats ends a wait, and the tolerated silence doubles per silent call. Heartbeats are protocol kinds (`ping`, `pong`), hidden from inboxes.
- **Turns, not waits.** The operator rejected blocking waits outright: with three agents, each waiting on another, nobody moves, and a blocked session cannot answer the operator. Also rejected: anything that only works on one laptop (I had probed the Claude session's messaging socket to nudge it; dropped). The model that is the same on a laptop and on VMs: a turn is inbox, work, write, end; turns are started from outside the model, by the operator in an interactive UI or by a watcher for a headless agent; heartbeats go to the watcher, not to a blocked wait. Interactive UIs have no external "start a turn" today, which makes them the operator's seat, not the autonomous agent's.
- **Roles.** `Roles: a=lead, b=implementer, c=reviewer` on a task; the requester or the current lead sets roles and assignees, others propose in replies. One lead per task; only the requester cancels.
- **Keyless local trust (codex).** Per-log checkpoints over accepted history, quarantine of a changed log, `forget` for the operator, 0700 rooms, no scope inheritance. My review reproduced one defect: including mtime in the digest made `cp -R` without `-p` quarantine every log; the digest now excludes it.
- **Skill.** The Agent Skills standard (SKILL.md with name and description) is read by Claude Code (`~/.claude/skills`), Codex and Cursor (`~/.agents/skills`), so one directory serves all three. The skill is deliberately short: identity, inbox, write, wait, trust.

## Open questions

- **Porting gaps** (codex's audit, 2026-10-11). Behaviour a Go or Rust port would still have to read from the code,
  in the order to specify it: (1) the CLI's JSON shapes and exit codes (wait 3, held budget 4, a cancelled dispatch
  settled with Exit 125); (2) session records (fields, file naming, the 60-minute lease, handle prefixes, watcher
  liveness by pid) and reader state (heads, cursors, pending and inflight checkpoints, heartbeats, run times, signal
  pins); (3) lock files (owner token, recovery gate) if homes are shared across implementations; (4) the watcher's
  environment (`RINGI_HOME`, `RINGI_SESSION`, `RINGI_MSGS`, `RINGI_GRANT`), its `sh` process group, 5 s grace,
  defaults (interval 5 s, window 86400 s, 10 runs) and grouping by grant; (5) rendering (12-character ids, UTC
  times, sizes) where tests read prose rather than JSON; (6) old home layouts and which JSON files reject duplicate
  keys; (7) the signed transport's recovery state (`push-alarms.json`).

- **Observability: is the agent working, and what does it spend** (proposal of claude and codex, 2026-10-11, awaiting
  the operator). Research: Claude Code, Codex, DeepSeek, vLLM, Ollama, llama.cpp, LM Studio, NVML.
  - *Four things kept apart:* the collector is alive; the agent is active (tools, tokens flowing); semantic progress (a
    stage done); usage (resources measured). A keep-alive or a collector tick proves activity of the transport, not
    progress; an overdue `Next` means a suspected stall or lost telemetry, never a finished or failed run.
  - *Reports* (`reports/1`, its own capability, non-waking kind): Re <work>, Stage, an opaque Run with host
    session/turn/request ids as correlation, Seq per reporter and run, a receipt id, Phase, Source and adapter version,
    Next, and resource values each with its provenance (measured, provider-reported, estimated, unknown) and the scope
    of its counter. Only normalized deltas enter accounting; raw provider usage rides as evidence. A model's stage report
    carries no numbers. Git: a commit in the reporter's log plus a derived immutable tag; Telegram: a message; Kafka: an
    event. Counting reports against grants belongs to decisions/2.
  - *Who writes, no model tokens:* the watcher reads the host's JSON (`codex exec --json`, `claude -p --output-format
    json`); an optional proxy reads API usage (DeepSeek and OpenAI-compatible local servers); host OTLP and GPU meters
    are later adapters. One canonical source per resource and run, or reconciliation by a shared request id.
  - *Presence* (busy, waiting on approval/input/tool, idle, unknown) is a later, optional live view outside history,
    with its own rules: bounded signed payload, sequence, expiry, one writer per seat.
  - *First lesson:* one empty-inbox poll by a model in this room reported 268,011 input tokens, 266,624 of them cached
    (1,387 uncached), and 281 output: a single sample, but it says to poll in code and wake a model only on actionable
    input.
- **Budgets as coordination, not enforcement** (proposal of claude and codex, 2026-10-11, awaiting the operator).
  The operator: enforcement is an orchestrator's job (Hermes, OpenClaw); ringi carries budget instructions and keeps
  the books, and tokens are only one of the resources work may need. Proposed as `decisions/2`:
  - *Boundary.* An executor (orchestrator, provider adapter, runner, person) enforces. ringi establishes authorized
    allowances, who reported what, the declared totals and what remains, revocation, overruns and missing reports, and
    tampering. It does not prove consumption, compel reports or prevent off-ledger work; totals read as reported.
  - *Resources.* Ids from a catalogue in the hub contract (`resources.json`: id, fixed unit, meaning), integer
    quantities (`usd-cent`, not float dollars). Cumulative consumption, occupied capacity and a per-run deadline are
    different things; the first version keeps cumulative amounts and visible reservations, capacity later.
  - *Placement.* Vocabulary: the contract. Who may allow how much of what: `authority.json`, per resource. Request and
    allowance: proposal and decision (`Budget`, `Reporters`). Binding to work: `Grant`. Consumption: usage receipts with
    resource, quantity, receipt id, phase and an optional evidence attachment. Views: signals. Execution policy: the
    executor's own, outside ringi. Profiles stay about work.
  - *Reporting.* Only reporters the grant names count; the CLI writes the proposer when none is given, the decision
    confirms or narrows. Others' receipts stay visible, excluded and alarmed. An authorized overrun counts and alarms;
    a settlement after revocation still counts for earlier work. Missing reporters mean unaccounted, not zero
    consumption; receipts are deduplicated by grant, resource, reporter and receipt id.
  - *Watcher.* Keeps coordinating turns (seats, stop, handoff, retries); its run limits become the reference
    executor's settings, not a protocol promise.
  - *Versions.* Version dispatch first; `decisions/2` in its own file; every existing proposal and grant keeps the
    version it was made under, so no rebase reinterprets old records.

- **Budget signals** (settled 2026-10-11, kept for the reasoning). The `Kind: usage` journal remains authoritative. Each counted receipt derives an author-bound `usage.reserve` or `usage.settle` tag on that receipt, signed on a signed hub, for tools and webhooks. Tags carry no additional spending: a missing tag changes no accounting, an accepted tag's deletion alarms, and `signals --repair` restores missing tags from the journal. An authoritative tag ledger would need a durable, complete reservation inventory and a fenced owner or trusted checkpoint for successor readers; private pins cannot reveal reservations deleted before a reader arrived. It would also need stable run identities, settlement bindings, explicit clock and executor trust, and a required accounting capability for older clients. The journal already supplies the inventory and ordering; retaining it avoids a second ledger and migration fold. Across machines the reservation stays non-atomic: one enforcing watcher per grant.


0.3, from codex's scope review: static allocations of a grant among named executors with a reservation journal and crash semantics; handoff with control generations; claims, leases and failover; token and money adapters; cross-hub work; on signed hubs: archive, deletion, member removal, key rotation and revocation, freezes, seals and repair.


1. `join` changes the room's roster on the operator's word in the chat. Fine while the operator is the only root; with other roots it splits into `room admit` by a root and `join` by the session.
2. Can a lead add members to a room? Not in 0.2: the lead sets roles and assignees among members and proposes additions in a reply; only the operator changes membership.


- **Retention.** Logs only grow. Options: epochs (a signed "continued in" message plus a new root commit), or git's shallow and partial clones.
- **Freshness.** One hub can withhold new commits. Options: witnesses, or relaying across two hubs.
- **Concurrent terminal states.** A cancel and a completion that are concurrent can swap order until replication completes. Irreversible work needs an acknowledgement protocol.
- **Hostile hubs.** Fetch size, history depth and attachment sizes are unbounded before verification.
- **Wake-up transport.** A Forgejo webhook that calls a runner, or polling `git ls-remote`; either one stays within the receiver's budget.
- **Large assets.** LFS, or pointers with hashes.
- **Encryption.** `age` per message and attachment, encrypted to the room members' SSH keys, so the forge's admin sees only metadata. Group keys for large rooms.
- **Rooms in practice.**
  - An agent in several rooms today needs one agent repo per room.
  - Forgejo provisioning should be one command: a repo per room, an account per agent, branch protection per log, read grants per room. amster's `make agent-add` already does half of it.
- **Context budget.** Long threads need summaries. Who writes them, and are they messages?
- **Roots.** Multiple roots, and the custody of the operator's key on VMs.

## ringi 0.2 (2026-10-10)

- **Name.** The prototype's command collided with a2ahub's binary and the Google/LF A2A standard; npm refused the unscoped `ringi` as too similar to `ping`, `ini`, `bigi` (its filter cannot be checked before publishing). Package `@idleware/ringi`, command `ringi`.
- **Why our own.** a2ahub (Go, v0.26) coordinates systems through GitHub PRs; its authentication is GitHub accounts and CI, the agent label inside a system is self-declared. ringi's differences: signed logs with untrusted hubs (SPEC), no forge, operator-driven sessions, decisions with budgets.
- **Sandboxes decide the home.** Measured with `codex sandbox -P :workspace`: only the project, `$TMPDIR` and `/tmp` are writable; `~/.ringi`, OS data dirs and the global npm prefix are not. So one grant (a writable root, or per-command escalation) and no per-project fallback.
- **Lessons from the tests.** A room's genesis commit was deterministic: a room deleted and created again within a second got the same sha, so its identity leaked into the new room; a random `Room-Id` fixed it. A stamp and a decision written in the same second are ordered by id, so a fold that stopped counting stamps at the decision lost them; stamps now count regardless. A node path with a space (`Application Support`) breaks an unquoted `--exec`.
- **Budgets, honestly.** Runs, run time and concurrency are enforced by the watcher that starts runs; tokens and money need adapters that can enforce them (codex's review). A reservation is atomic only under one lock: one machine, one local hub.

## ringi: TypeScript, stores, profiles, signals (2026-10-11)

- **The operator's correction.** Configuration had gone into git itself; git is only `store.type: git`, and tomorrow it may be temporal or Kafka. A hub is now a descriptor (`hub.json`: store type and place, trust, pins) beside a store; rooms, history, profiles and decisions use only the `Store` port.
- **Not a methodology.** Roles (architect, manager, developer, reviewer, tester) and task states are each team's or framework's (Hermes, say). The A2A task model became one profile, `a2a-1`; the core interprets any profile and knows no state or role by name. Codex's review shaped the details: rights judged on the work before the message, `agent:<id>` principals, exact rules over `state:*`, the profile copied into the room's genesis so later changes never reinterpret history.
- **Signals.** Git-native, signed markers of counted transitions (tags under the room's genesis), checked against their messages and pinned by readers; the log stays the truth.
- **Typed.** Moving to TypeScript surfaced two crashes the tests had missed (`ringi --version`, `ringi hub create` referenced names that were never imported), and reading commit messages as UTF-8 strings had silently replaced invalid bytes, so the "invalid UTF-8" rule could never fire; messages are read as bytes now.

## Decided in 0.2

- **Task without `--to`** (the operator's decision; codex preferred a required `--to`). The root may draft a task in several commits addressed to the room, which wake nobody, and then delegate: `ringi send --re <task> --assign codex` addresses the assignees (`To` defaults to `--assign`), and that message wakes them. The CLI notes on a task without recipients that it wakes nobody yet.

## ringi: purpose, domains, specs per version (2026-10-11)

- **Purpose, stated.** The operator: a coordinator, not an orchestrator. Orchestrators (Hermes, n8n, OpenClaw) run
  processes and decide what happens next; ringi connects the parts and keeps them in sync, auditable, verifiable and as
  secure as is reasonable. What a task is, which roles exist, how agents think or run travel as data. Every change is
  judged against this.
- **Domains.** The operator asked where a control panel would land. The code is now lib, protocol, domain (pure
  folds per capability), store, home, hub, runtime, app (use cases shared by every interface), interfaces (cli,
  panel). One direction of imports, checked by a test. The CLI parses and prints; the panel will call the same `app`.
- **Evolution in the structure.** Specs are files per version ([spec/](spec/)); capabilities are `<name>/<major>`,
  one major per name per contract, enforced only through the module registered for that id; migrations are code with
  a test.
- **Docs, simpler.** PROTOCOL.md and CLI.md became the specs (core, profiles, decisions, signals, hubs); NOTES became
  this file; the earlier drafts moved to history/ unchanged.
- **The local flow, end to end.** Codex's acceptance test played the README's local scenario on a fresh home and
  found six gaps. Fixed: an explicit `watch --handoff` from the chat that holds a seat (scope kept, `continue` takes it
  back once the watcher ends); `watch --once` exits with the failed turn's status; a failed turn is retried with the
  same messages, but a turn stopped at its run-seconds is not, since that cap was the decider's; an identical file
  attached again is no longer lost (`Ringi-Files`); the chat's own `continue` after a watcher.
  A walk through the README by hand found two more that the tests had not: piping a command into `head` crashed with
  EPIPE, and reading an archived room alarmed on every signal, because the archive moves signal refs while readers
  pinned them by full ref; pins are now keyed by `<actor>/<message>.<signal>`.
- **Portable by design.** The operator: ringi will likely be rewritten in Go or Rust; porting must be a snap. So: specs
  first, no runtime dependencies, text and small JSON formats, optional adapters for anything heavy, and the CLI tests
  as a conformance suite (`RINGI_BIN`).

