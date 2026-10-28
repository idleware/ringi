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

1. **One log per agent, one writer.** (Superseded 2026-10-11 by 12: one branch per room.) A shared branch races with constant non-fast-forward pushes; amster showed that. Per-agent logs need no coordination: every push fast-forwards, and replicas merge as a plain union.
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
12. **One branch per room** (2026-10-11, the operator: "a stack of messages like a chat, one branch per task, not five").
    - The room is one linear branch: the root's genesis, then messages by their authors and the root's control records, in one order that any git client and forge shows as is ([hub-1](spec/hub-1.md)).
    - A member's log is its own commits in that branch; pins, rollback alarms and `forget` work per author as before.
    - The race of decision 1 is a retry: a writer that lost the compare-and-set makes its commit again on the new tip.
    - The cost: a forge no longer keeps one writer per branch, so on a signed hub signatures and the room's roster, not branch rules, say whose commit counts, and a member can litter the branch (visibly, under its own account).

**Rejected:**

- A shared branch per conversation: it races. (Taken back by 12: the race is a retry.)
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
  in the order to specify it: (1) the CLI's JSON shapes and exit codes (3: a wait that timed out, a join that awaits admission);
  (2) session records (fields, file naming, the 60-minute lease, handle prefixes) and reader state (accepted heads,
  control and signals, delivery cursors, staged files); (3) lock files (owner token, recovery gate) if homes are
  shared across implementations; (4) rendering (12-character ids, UTC times, sizes) where tests read prose rather than
  JSON; (5) which JSON files reject duplicate keys; (6) the signed transport's recovery state (`push-alarms.json`).

0.3, from codex's scope review: claims, leases and failover; cross-hub work; on signed hubs: deletion, member removal, key rotation and revocation, freezes, seals and repair.


1. `join` changes the room's roster on the operator's word in the chat. Fine while the operator is the only root; with other roots it splits into `room admit` by a root and `join` by the session.
2. Can a lead add members to a room? Not in 0.2: the lead sets roles and assignees among members and proposes additions in a reply; only the operator changes membership.


- **Retention.** Logs only grow. Options: epochs (a signed "continued in" message plus a new root commit), or git's shallow and partial clones.
- **Freshness.** One hub can withhold new commits. Options: witnesses, or relaying across two hubs.
- **Concurrent terminal states.** A cancel and a completion that are concurrent can swap order until replication completes. Irreversible work needs an acknowledgement protocol.
- **Hostile hubs.** Fetch size, history depth and attachment sizes are unbounded before verification.
- **Wake-up transport.** A Forgejo webhook that calls the operator's runner, or polling `git ls-remote`; either one wakes in code, never a model.
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


## ringi: core, adapters, clients (2026-10-12)

- **Quality first.** Qlty rated the code F (91 smells); the operator: write it properly from the start. Fixed by
  splitting modules, never by raising thresholds; every commit is checked with `qlty smells --all` and the CI command
  in a Linux container.
- **The operator's correction.** The top level mixed layers (lib, protocol, domain, app, runtime), contexts (hub,
  heartbeat, home) and adapters (store/git): heartbeat and home were not where they belonged, `domain` named nothing,
  and replacing git with Telegram groups, n8n rails or Kafka topics would have meant edits across the tree. Now three
  roles, each a future package: `core/` (hub, agents, signing), `adapters/` (one per way ringi meets the world),
  `clients/`, with `lib/` beneath them; `composition/` alone knows the adapters. Agreed with codex over three rounds
  (`ddd/` in the room).
- **Ports beside their owners.** `hubPorts()` (this build, the machine's state, the store types) and `agentPorts()`
  (agent tools, processes); a `Signer` is given to the signed transport only. Rejected: one registry for all (the hub
  would depend on the agents' contracts), and the names `coordination`/`execution`/`telemetry` (the operator's words
  are hub, agents, heartbeat).
- **One module per spec and capability.** `work` (profiles), `decisions`, `signals`, `history` stay apart inside the
  hub, so a capability's second major is a module beside the first.
- **What a store must guarantee** is stated before another one is written: a Telegram group (updates kept 24 hours,
  messages that may vanish) needs its own replica and checkpoints; Kafka orders only within a partition. Order alone
  is not enough: identity, immutable content, replay with an explicit outcome, evidence, idempotent append.
- **Keys.** On an asserted hub nothing is signed: whoever can write its repository can delete it or write as anyone
  (the operator), so a signature would protect nothing. Its rules still coordinate: the watcher checks grants
  (approval, revocation, spending, concurrency) on either kind of hub; only a signed hub also proves who wrote what.
  A signed hub's root key may live in an SSH agent such as 1Password, unlocked by fingerprint; until that adapter
  exists, keys stay files (`keys-file`).
- **Names.** `kernel` beside `core` read as two cores (the operator); the helpers that know nothing of ringi are `lib`
  again, now without files and locks (`adapters/fs`).
- **Gates, not migrations (later the same day).** The operator: what matters is a compatibility check; a hub the new
  ringi cannot read is replaced by a new one beside it (`local2`) or a new root branch on a forge; migrations only if
  cheap, and beside the code, not through it. They were not cheap: about 700 lines reaching into branches, deletion,
  signal pins, push alarms, the home and the CLI. Gone: `room migrate` and the 0.1 room layout, the home v2 move, pins
  in old key formats, push alarms kept in git config, the renamed pulse pidfile (`pulse.json` now), the contract named
  `hub.json`, the library's `STORES`. In their place, gates in one place (`core/hub/rooms/compat.ts`, the home's in
  `adapters/state-fs`): descriptor schema, contract major, protocol major (promised before, now checked),
  capabilities, and the store's layout, which a new contract names (`store: git/2`, contract 1.2) and the store type
  finds by looking when an older one does not (codex: no field proves nothing). Each refuses with what to do; a layout
  older ringi cannot read also raises the contract major. A migration, if ever worth it, is a tool beside ringi. The
  `Store` port is split by what each part does, and hub-1 states what a log must guarantee.

## ringi: a coordinator, cut to size (2026-10-12)

- **The operator:** less code is always better; whatever does not fit the strategy goes. The strategy is the purpose
  stated on 2026-10-11: a coordinator, not an orchestrator. Starting turns, spending and approving work is what an
  orchestrator does (Hermes, n8n, OpenClaw), so ringi stops doing it. The live room used tasks, states, assignment,
  files, signals, marks and heartbeats; nothing else.
- **Gone.** `decisions/1` whole (proposals, stamps, decisions, budgets, grants, usage receipts, `authority.json`); the
  watcher (`ringi watch`, its turns, checkpoints, retries, hand-off, process groups, the zombie settlement just
  finished); `agent ping` and pongs; agent cards; `room archive`; the CPU reading in heartbeats; the planned
  `transport-kafka` and `transport-temporal` stubs; reader budgets and run times. 34 files, about 2,200 lines.
- **No major.** ringi is 0.x and used in one project. `decisions/1` stays registered as a retired capability that
  restricts nothing, so a contract that names it (the live hub's) opens. A profile's `grant` rule is still accepted and
  allows nothing. Rooms holding decision records are not supported, and nothing refuses them: they read on, their
  messages as plain ones and their signals as ignored alarms (codex's fixture), until the operator replaces such a
  room with a new one. The live hub has none (no such kinds, tags or archives, checked). `ping`,
  `pong`, `usage` and `card` are plain kinds again (core-1 lost its heartbeat and waking rules: ringi starts no
  turns). Archived rooms' refs, where they exist, stay in the store unlisted; a reader's old watcher fields are
  ignored. Presence stays: it is the store's heartbeat, written by the pulse, not a message.
- **Rejected with it.** Budgets as coordination (`decisions/2`, the open proposal of 2026-10-11), budget signals, usage
  reports and observability of spending: each is the executor's books. What stays from that research: poll in code
  and wake a model only on actionable input (one empty-inbox poll cost 268k input tokens).
- **Smaller ports.** `ProcessHost` is `supported`, `alive`, `ancestors`, `start`; the store's administration is
  `deleteRoom`; `Store.contractFiles` and the transport's `rootKey` went with the authority table.

## ringi: a hub of repositories, a room's branches by meaning (2026-10-13)

- **The operator's idea.** Asked to let the operator set up forge access (repository, agents' keys, a room as a
  branch, an invitation as a branch grant) "seamlessly, like amnezia", we found a branch grant does not reach signal
  tags, read access is the whole repository's, and deleting a protected branch is a chore. The operator: "a space is
  a hub, a room is a repository; one task, one room, one git; deleting it becomes trivial". It brings back decision 11
  (a room is one repository, read access per room) and fits Forgejo, GitHub and GitLab alike; decision 12 (one chat
  branch per room) stays inside it.
- **Branches by meaning, not tags** (the operator, same day): in a room's repository `chat` is the conversation with
  the root's control records, and each agent writes its own `<agent>/signals` and `<agent>/telemetry`, one writer per
  branch. Tags grew with every message, a forge cannot give an agent its tags alone, and they needed their own pins,
  sync and leases; a branch is one ref, linear, checked like the chat. Signals keep their meaning in a new form,
  signals-2; heartbeats become the telemetry stream. Files stay in chat commits; `<agent>/files` is reserved for a
  capability when large artifacts need it (codex's estimate for doing it now nearly doubled the work).
- **Shape** (codex's layout, simplified): a hub descriptor `ringi-hub/3` keeps the contract's store and one endpoint
  per room (`rooms/<name>/`, its genesis pinned there); a selected room opens its own `Store`, never a store that
  multiplexes rooms; what a reader accepted is keyed by the hub's and the room's genesis, not by names or URLs. A
  room's repository is self-contained: the contract's history up to its base, then the chat, so a member needs one
  repository. A room keeps the contract it was made with; a new contract is for new rooms.
  Deleting a server's copy and deleting a machine's evidence are separate acts.
- **No migration.** Contract major 2 with layout `git/3`, descriptor `ringi-hub/3` and home 4; everything of contract
  major 1 is refused, so the historical contract reader, the layout probe for contracts without `store` and the
  retired `decisions/1` entry go. The ringi that made an old home still reads it, from wherever the operator moves it.
- **Access is a separate adapter** (Forgejo first), not a store: it finds or makes the space and a room's repository,
  gives an agent's key access to a room and takes it back. Trust stays end to end: the root, the pins and signatures
  decide what is accepted; a forge's rules are defence in depth. A repository-scoped key is a transport credential,
  apart from the signing key; GitHub allows a deploy key on one repository only and no automatic machine accounts.
  Revocation in the first version is the medium's only; the protocol's is a later step.
- **Adapters named by type**: `store-git`, `agent-claude|codex|cursor` (and their shared `agent-traces`), `keys-file`,
  `host-posix`, `state-fs`; `access-forgejo` next.
- **A smaller CLI** (the operator: "an agent does not care about the hub: it has a room and the contract in it"; "the
  simpler the API, the better"). An agent joins a room by its name, or by the operator's invitation, one `ringi:` line
  (the room's address, its genesis, the hub's genesis and the root's public key); it never names a hub, and its
  machine keeps the hub only as the pins its rooms share. A room's name is unique on a machine, so the operator needs
  no current hub either. Gone: `hub add`, `hub switch` and the current hub, `room remove`, `room rebase-contract` and
  copying contracts into rooms, `sessions` (where and heartbeats show them; `continue <room>/<agent>` takes a stale
  seat), `who`, staging (`add`; `--attach` remains), and `skill status | show | --project`.
- **A room's address names its store** (the operator: "a room's identifier needs a prefix of its implementation: git,
  a database, something else"): `git+ssh://…`, `git+https://…`, `git+file://…` as npm and pip write them, and the
  scheme of whatever comes later; ringi refuses an address that does not say.

## ringi: rooms on a forge (2026-10-13)

- **Accounts, not deploy keys.** On Forgejo a protected branch allows writable deploy keys all together or not at all
  (codex, from its source: one `WhitelistDeployKeys` flag, checked for any key), so a key per actor cannot keep an actor
  to its streams. Each actor writes through its own account; ringi creates none, and puts the agent's key on it only
  when the operator's token may. This is the operator's first idea for the forge ("register the agents, push the key
  to their profile"), arrived at by elimination.
- **Exact rules and a closed rest.** `main` and the operator's own streams for the root, `chat` for the root and
  admitted actors, `<actor>/signals` and `<actor>/telemetry` each for its actor's account (one account per actor, the
  root's for none), `**` for nobody and every tag for the root alone (Forgejo refuses a tag rule that names nobody); literal rules win over globs
  there, and nothing ringi reports is assumed: every grant is read back and anything wider is refused.
- **SSH only through a forge.** An SSH address needs its host's keys pinned and a key bound to each machine; only a
  hub on a forge keeps both, so `--url` by hand takes `git+https://` or `git+file://`, and `--forge` requires
  `--host-key-file`. Nothing falls back to `~/.ssh` or `GIT_SSH`.
- **The access address is typed like a store's**: `forgejo+https://forge/org`, its scheme naming the adapter. The
  operator's token stays in a file the operator points at; the agents' SSH identity is their own ringi key by default,
  through an explicit transport provider, and the forge's host keys come from the operator and travel in the
  invitation (`ringi-invite/2`), never learned on first use.
- **The contract stays home.** Agents need only their rooms' repositories, each carrying the contract it was made
  with, so a forge hub publishes no contract repository.
- **No Forgejo client library.** TypeScript clients and declared-state tools for Forgejo exist; the adapter uses about
  a dozen documented API calls through `fetch` instead, since ringi takes no runtime dependencies and the token
  passes only through code in this repository.
- **The first join over SSH.** Before its admission an agent cannot read the room's repository, so its key is made
  before the first fetch, and an explicit SSH access refusal shows that key to admit; any other failure is reported
  as it is, never as "not admitted yet".

## ringi: transport and protocol, no presence (2026-10-14)

- **What ringi is.** The operator: ringi does two things, the transport and an extension of the A2A protocol. Whether
  an agent is alive or working is its orchestrator's question, so the heartbeat is gone: no `pulse`, no
  `heartbeats`, no `<agent>/telemetry` stream, no Presence in the store, no reading of the tools' traces. A quiet
  session fetches nothing on its own; the orchestrator wakes or polls it. The telemetry branches of older rooms stay
  where they are, unread. Watching sessions may become a package of its own for orchestrators (parked in the
  workspace backlog as agent-session-probe).
- **A read is a cursor.** The operator: an agent saw what came before the message it marked read, so it needs one
  marker it moves, not a mark per message. Messages are ordered per author's log and by what they answer (core-1
  §5), not by the chat branch, so the cursor is per log: a delivery marks the last message of each log it reached,
  and a message counts as read by everyone whose cursor in its log reaches it and to whom it was addressed. Older
  per-message marks read the same way. At most one mark per author per turn instead of one per message.
- **What a host enforces is the host's.** Free plans of GitHub (private repositories get no branch protection) and
  GitLab (pushes allowed by role, not per user) cannot keep an actor to its branch or refuse a force push. The
  operator: the first record is always the root's; that any member may tamper on the server afterwards is accepted,
  and whoever wants less risk runs a host of their own or pays for a plan. The specification says so, with
  what still holds (signatures, pins, alarms) and what does not (prevention, and a later joiner may accept a shortened
  history).

## ringi: rooms by address, invitations, removal (2026-10-17)

- **A room has an address.** The operator: `fix` means `local://fix`, in the home's room directory;
  `local:///abs/path/fix` keeps a local room anywhere; `forgejo://host/space/room` (and `github`, `gitlab`, `gitea`)
  is a room in a space, with `gh` and `gl` accepted on input only. Without a room name, create picks a random one.
  `--hub` is gone: the address says where a room is. A bare name selects the one known room of it, or refuses. Rooms
  in a space are always private.
- **Who an actor is.** The operator: no `--as` for remote actors. A local agent is its tool (`claude`, then
  `claude-2` while another session holds that seat), since this machine is trusted; `--as` stays for a chat whose tool
  ringi cannot tell. In a space the root invites known accounts (`--invite` at create, `room invite` later), and an
  actor is the account's login; one that comes back is the next unused `<login>-<n>`. A seat released by `leave` is
  taken again by the next chat of that name, with its work, as in 0.10.
- **The host vouches for the key.** The invitee puts the key its machine shows on its own account; the root reads the
  account's complete key list before it admits, and admits nothing an account does not show. A key pair is the
  relation of a machine and an account: one per host realm and account, reused across that host's rooms. GitHub
  free organisations get a deploy-key mode, a key per room that the root vouches for.
- **Removal is whole and terminal.** One key per actor; no key sets, no partial removal, no freeze or finality
  protocol. A removed actor's stream is a projection each reader closes where it stood when it saw the removal;
  readers may differ by it, which is no alarm. The account may return, as a new actor with a new key.
- **The command line drops the manual signed hub.** A signed room is always in a space there; `hub create`,
  `--signed`, `--url`, `--forge` and `--auth-file` are gone, and the first room in a space takes `--token-file` and
  `--host-key-file`. The library keeps a signed room outside a space, its root, signer and transport injected, admitted
  by the operator's paste, as the agreed contract has it; a third invitation mode for it would have been complexity
  for no user.
- **Delete moves aside, it does not erase.** Rooms come and go locally, so `room delete` must work: a repository ringi
  made in the home goes to `trash/`, one at the operator's own path stays there, and the registration with its root
  list moves whole to `room-archives/`, so an address made again starts with an empty list. Nothing claims secure
  erasure.
- **A new home, no migration.** Home 5, endpoint `ringi-room/2`, layout `git/4` with `rooms/1`, `ringi-invite/3`, all
  together. Rooms of 0.10 stay readable by 0.10 in their own home.

## ringi: GitHub spaces with deploy keys (2026-10-20)

- **A space fixes how its actors come in.** At its first room: through their own accounts where the host keeps an
  account to its own branch (Forgejo), else with a write deploy key per room that the root vouches for (GitHub's free
  organisations protect no private branch). `--mode` asks for one; a host that cannot do it refuses before anything is
  made, and a later room cannot change it. Forgejo gets no deploy-key mode: a deploy key there could not be kept to
  its branch either, and accounts can.
- **GitHub, honestly.** The root is a room's only collaborator and the organisation's base permission is read or
  none, or `room create` refuses; whoever holds a deploy key writes every branch, which the adapter reports as it is.
  Host keys come from `/meta` over TLS when the operator gives none. A rate-limit refusal says when it lifts; ringi
  does not wait or retry. Account mode on GitHub's paid plans waits for a check of what branch protection and rulesets
  can keep to one user.
- **Gitea gets its own adapter.** Its API is Forgejo's ancestor, but it applies the first matching branch rule by an
  explicit priority and puts a rule without one last, so Forgejo's adapter could let a late grant fall behind the
  closed rest. Gitea's sets and reads back every priority, and reads only the API versions it was checked against.

## ringi: agents wake themselves through their hosts (2026-10-21)

- **Ending a turn left nobody to start the next.** The skill said "end the turn" and nothing more, so a joined agent
  went quiet for good (it happened again in a room with Codex). ringi still keeps no presence and runs nothing; the
  skill now asks each agent for one wake-up of its own host per room and chat (a Codex heartbeat, a background
  `ringi agent wait` in Claude Code), checked before every turn ends, or to tell the operator that its host has none.
- **What a wake does.** Backoff 2, 4, 8, then 10 minutes, and 30 when the agent has no open work and waits for
  nothing, since every wake costs a turn; news for the agent, progress or the operator's word resets
  it, an empty inbox does not. Each wake checks the seat, the inbox, the agent's open work and the condition it waits
  for, once each, keeps one short continuation note, and stays silent unless there is a result, a failure or a
  decision for the operator. Stop pauses the wake-ups, leave ends them, a peer cannot touch them.


## ringi: a security review, model and implementation (2026-10-26)

- **How.** Claude reviewed the model (trust boundaries, membership, pins, invitations, the root's machine), Codex the
  implementation (keys, verification, git, attachments, SSH, tokens, home, output, supply chain); each reviewed the
  other's part. The core held: a record counts only after its signature is verified at its place, the roster comes
  from root-signed records, `allowed_signers` takes no options from a key line, SSH pins its host keys and reads no
  `~/.ssh/config`.
- **Fixed.** `get` writes a peer's paths only into a directory it makes, never over a file or through a link, and
  `.git` is refused in any spelling a file system folds to it (core-1 §4). `room create` adopts only the repository
  its own create made, by the provider's id kept beside the registration, and `--server` deletes only that one; a
  repository of the same name is refused untouched. Every git command runs under one policy (`GIT_ALLOW_PROTOCOL`,
  no fsmonitor, no hooks). State files are written through a new owner-only temporary file, a home others can write
  is refused, JSON deeper than 64 levels and invitations longer than 16 KiB are refused, `cat` shows control
  characters on a terminal. Create, invite, join and admit print fingerprints for the operator to compare. API calls
  share one deadline, bounded replies and a redacted token. A reader fetches only main, chat and the streams of
  members it verified: unrelated heads stay on the host, though a required stream may still be large; this is a
  selection, no disk quota.
- **Said, not fixed.** On the root's machine every agent running as the operator's user is the root: ringi's command
  names are no permission (TRUST.md). A host the operator does not run can show readers different continuations.
  What to do when a machine is stolen, the root is lost or the chat is rewritten is in REMOTE.md.
- **Next, each its own decision.** An agent-held root key (an SSH agent that asks before each signature), an
  invitation that pins the chat head it was printed at, a least-privilege GitHub token checked against every call.
  Fewer connections per sync of a room in a space (one listing, one fetch).
- **A restart broke every room.** A directory's identity was its device, inode and birth time; macOS gives an APFS
  volume its device number when it is mounted, and after a restart it was another, so every room on the machine read
  as a replaced repository. The device is no longer compared where a fresh look meets a stored one, and the stored
  format is unchanged: a copy still has another inode and birth time. A cloned volume mounted at the room's path is
  not told apart; only the operator's own user can mount there, and it can rewrite the records anyway, so a volume
  id read on every check (diskutil, findmnt) was rejected as more than it is worth.
- **Rejected.** A description marker as proof that a repository is the room's: anyone who can edit the repository can
  copy it. Witnesses against a forking host, key rotation, our own crypto envelope: more than they are worth now.
