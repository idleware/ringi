> History, kept whole: the requirements behind that draft; the local story is implemented, the distributed one in part (hub-1, Signed hubs).

# Requirements: trusted workspace for multi-agent tasks

Derived from [DESIGN.md](DESIGN.md) and [REVIEW.md](REVIEW.md); ids in brackets point there. Priority: **M** must (v1), **S** should (v1 if cheap), **L** later. Every M requirement must be testable; the acceptance matrix in DESIGN.md is the test plan.

## Two stories

1. **The message protocol** ([PROTOCOL.md](../PROTOCOL.md)): text, addressing, threads, tasks, inbox, waking. Independent of transport and trust.
2. **Bindings**, each a transport plus a trust model:
   - **local** (the former directory binding): a directory in a local project. No git, keys or hub; the operator controls access. This is today's use: Claude and Codex on one machine.
   - **git** (the signed git binding (now `remote.mjs`)), together with the task workspace ([DESIGN.md](DESIGN.md)): signatures, roster, forge, runners on VMs. This is the distributed story; everything below the next section belongs to it.

## Protocol and local binding

| Id | Requirement | Pri |
|---|---|---|
| P1 | Write a message (text plus files) into one's own log, atomically. Ids are `<agent>/<seq>`, collision-free across processes of one agent | M |
| P2 | Inbox, read, thread and task status per PROTOCOL §5–6, with per-reader cursors and at-most-once delivery | M |
| P3 | Strict parsing: the text rule, malformed trailers route nowhere, files are regular files only with safe paths | M |
| P4 | A wait or watch that wakes on new messages without polling models, under a receiver policy: senders, effective hop, persisted run budget | M |
| P5 | Plain tools suffice: an agent with only `cat`, `ls` and a text editor can read and write correctly (LOCAL "Writing") | M |
| P6 | One CLI and one skill for Claude and Codex alike, as a CLI and optionally an MCP server | M |
| P7 | No dependencies beyond the runtime; macOS and Linux; works inside a project directory | M |
| P8 | The same message text and task semantics as the git binding, so a room can later move to git without changing how agents talk | S |

Not required for the local binding: keys, signatures, roster, forge, sandboxes, budgets in money. The operator's control over the machine is the trust boundary.

## Distributed story: git binding and task workspace

## Components

| Component | Runs on | Role |
|---|---|---|
| **op**: operator toolkit | the laptop (macOS) | root signing, tasks, grants, review, close, enrollment, recovery |
| **runner** | each agent VM (Ubuntu, 1 vCPU / 1 GB / 10 GB) | privileged daemon: verify, journal, budgets, sandbox, model invocation, signing, push |
| **skill** | inside the model's sandbox | model-facing commands over the runner's socket |
| **core** | shared library | the wire format: SPEC plus the task extension, verification, parsing |
| **forge** | Forgejo on a VM | storage, ACL, hints; untrusted |

## Functional requirements

### Identity and enrollment

| Id | Requirement | Pri |
|---|---|---|
| F1 | **Found a network.** Create the roster (`main`: `allowed_signers`, `frozen`) signed by the root key. The genesis is the network's identity | M |
| F2 | **Invite.** Produce an invitation holding only public anchors: root key, genesis, forge URL. On the VM, enroll: generate the key pair locally (it never leaves) and print the public key | M |
| F3 | **Admit, rotate, revoke.** Admit puts a public key into the roster with a root-signed commit. Rotate and revoke retire the old key with a branch-aware freeze; branches without an anchor are denied by default. Revoking a key voids its in-flight attempts (they become uncertain) | M |
| F4 | **Root signing path.** It shows the exact typed operation and the manifest hash before signing. It works with a key on hardware (`ed25519-sk`), with support verified on both the signer and the verifiers | S |

### Tasks (op)

| Id | Requirement | Pri |
|---|---|---|
| F5 | **Create a task** from a directory (`TASK.md` and assets). The operator gives the participants with roles and allocations (in units), a deadline, acceptance criteria, and the allowed providers and tools. The task id is collision-resistant and bound to network and epoch. The task becomes a typed control record (`Kind: control`, `Version`, `Grant`, `Manifest` blob hash) on `task/<id>`, anchored to the genesis | M |
| F6 | **Grant on the forge.** Default-deny (`**`) is in force before any agent account can write. For each task, an exact allow-rule for its participants exists before the branch is pushed. No force-push and no deletion for agents. Actions are disabled on the bus repo | M |
| F7 | **Change authority** (participants, allocations, deadline) only through a new control record. It is idempotent and never resets consumption. A participant who is removed has its attempts closed | M |
| F8 | **Status.** Per task and participant: queued, working, waiting, input-required, review, closing, settled, closed. Units spent with the cost (or "unknown"), and alarms | M |
| F9 | **Reply** to questions, **cancel** a task or one participant, **retry** a participant with an explicit new attempt | M |
| F10 | **Review.** Show results from verified history only, with escaped and limited rendering. Acceptance binds the exact commit and artifact hashes | M |
| F11 | **Close**: fence, archive (`refs/archive/…`, objects verified), receipt and tombstone, backup or an explicitly accepted loss window, publish the tombstone, conditional delete (`--force-with-lease` with refspec), unprotect. Each step is journaled and resumable | M |
| F12 | **Rejected closure and recovery** for a poisoned branch. The quarantined evidence is kept; a recovery task names its salvage base | M |
| F13 | **Settlement channel.** Collect runners' final receipts and usage after the fence, for example by the operator pulling runner outboxes over SSH | M |
| F14 | **Bounded delegation.** A lead may create subtasks or retries inside an envelope (budget, participants, depth) without the laptop | L |
| F15 | **Machine-checked acceptance criteria** (tests) run in an isolated environment | S |

### Runner (agent VM)

| Id | Requirement | Pri |
|---|---|---|
| F16 | **Discover work.** Poll the forge with no model involved; webhooks only as hints; reconcile missed work. The branch-name id must equal the signed id. Refuse tombstoned and closed ids from local memory | M |
| F17 | **Verify** every new commit from raw objects in an isolated git environment: signature, the operator's authority (typed control), participant membership, one parent, the network anchor, freezes, UTF-8 and control characters, and size caps. Stop at the first invalid commit and quarantine the rest | M |
| F18 | **Attempt and turn engine.** A durable journal per attempt. A reservation is written before every turn. Limits on turns, wall time, units and deadline. Events queue and coalesce, with one active turn per attempt. A crash leaves the turn uncertain and consumed; nothing reruns automatically. Attempt identity is `(epoch, task, agent, key, role, attempt)` | M |
| F19 | **Model adapters**: Claude Code (`claude -p`) and Codex (`codex exec`), extensible to others. Pass the skill, enforce wall time, kill on cancel, record usage when the provider reports it and "unknown" otherwise | M |
| F20 | **Sandbox per task.** The model runs as a separate Unix user or in a container. It has no access to the runner's keys, sockets or state, or to other tasks. Network egress follows the task's allowed providers and tools. Builds and tests run without credentials | M |
| F21 | **Skill RPC.** A socket bound to one session: `show`, `say --to [--re]`, `put(bytes, logical_name)`, `state`, `ask-operator`. Session identity comes from the verified record, never from the model. Calls carry request ids and are checked on every call | M |
| F22 | **Publish.** Build commits from an immutable staging snapshot, sign them with the agent key and push. Fetch, rebase (only drafts whose references are already published) and retry, with bounded retries. Deduplicate by request id. No merges, ever | M |
| F23 | **Safe materialization.** No symlinks, gitlinks, submodules, LFS, filters or hooks. Validate paths (case and Unicode collisions). Caps on transport, objects, extraction and staging | M |
| F24 | **Durable outbox** for late or fenced results, reported over the settlement channel. A closed branch is never recreated | M |
| F25 | **Re-provision.** A fresh VM enrolls with a new key and inherits no attempts | M |

### Operations

| Id | Requirement | Pri |
|---|---|---|
| F26 | **One-command provisioning** of an agent VM: runner install, Unix users, sandbox setup, enrollment, forge account and token, provider key with a spend cap. In the style of the amster and zurich reconcilers | M |
| F27 | **Alarms** reach the operator: forks, rejected commits, quarantine, budget exhaustion, delivery failures, uncertain spends | M |
| F28 | **A local audit trail**: signed receipts in the laptop's history, readable with plain git | M |

## Non-functional requirements

| Id | Requirement | Pri |
|---|---|---|
| N1 | **Trust boundaries.** The forge, models and peers are untrusted. Content becomes authority only through signatures and typed control. The system fails closed on any unknown authority field or protocol version | M |
| N2 | **Isolation.** Keys and the runner's state are unreachable from every model process, even with a shell. Task sandboxes are mutually invisible | M |
| N3 | **Crash safety.** Atomic, fsynced journals and idempotent operations; every multi-step operation resumes. There is no silent refund and no silent replay of an uncertain spend. Exactly-once is not promised | M |
| N4 | **Autonomy.** Execution continues while the laptop sleeps or is offline for days. While the forge is down, runners keep work locally and retry without rerunning models. v1 needs no always-on trusted service | M |
| N5 | **Budget safety.** No model turn without a signed grant and a persisted reservation. A hard per-VM spend limit is set at the provider. Units are invocations, wall time and tokens where known. Worst-case overspend is bounded by that per-key cap | M |
| N6 | **Small footprint** on 1 vCPU / 1 GB / 10 GB VMs: the runner idles under ~50 MB RSS and has no heavy runtime. Installation is offline-capable, a single artifact plus `git` and OpenSSH ≥ 8.8 | M |
| N7 | **Platforms.** The runner runs on Ubuntu 24.04+ under systemd. op runs on macOS (the laptop), and on Linux as a nice-to-have | M |
| N8 | **Interoperability.** The wire format is plain git plus SSH signatures (SPEC), so a second independent implementation stays possible. The skill is exposed as a CLI and an MCP server, so Claude, Codex and others use the same contract | M |
| N9 | **Determinism.** Parsing is strict (no duplicate keys), ordering is defined (Kahn), and verification is the same on every node and every version that shares a protocol version | M |
| N10 | **Testability.** The acceptance matrix runs automatically against throwaway git fixtures and a local Forgejo, adversarial cases included. CI on every change | M |
| N11 | **Latency.** Work is picked up within 60 s by polling, or seconds after a webhook hint. A task branch of a few hundred commits verifies in a few seconds on the small VM | S |
| N12 | **Scale.** Tens of tasks per day, up to about ten agents, one forge. No horizontal scaling needed | M |
| N13 | **Observability.** Structured logs per task and attempt, with no secrets and with control sequences escaped. Alarms are actionable and name the next step | M |
| N14 | **Operability.** Configuration as code; re-provisioning is the only recovery for a VM. Upgrades do not break in-flight tasks, thanks to the protocol version and graceful drain | M |
| N15 | **Data handling.** Retention is declared. No secrets go through the bus. Deleting a branch is never presented as erasure | M |
| N16 | **Maintainability.** A small codebase the operator can read and change. Few dependencies, each one pinned and justified | M |

## What constrains the technology choice

The two stories constrain it differently:
- **Protocol and local binding (P1–P8)** is small: files, atomic renames, a CLI, a skill. Any runtime the operator likes fits, and Node/TypeScript is the operator's own stack.
- **The distributed runner** carries every hard constraint below. It can be chosen separately later, since both stories share only the message text and semantics.

For the distributed story, these requirements narrow the choice most:

1. **N2 + F20 + F21: privilege separation on Linux.** We need peer credentials on Unix sockets (`SO_PEERCRED`), and file access relative to directory fds (`openat2`/`RESOLVE_BENEATH`, `O_NOFOLLOW` on every component). Sandboxes come from systemd (`DynamicUser`, `ProtectSystem`, IP filters) or bubblewrap. The language must give direct, low-level syscall access.
2. **N6: small VMs and a single artifact.** A static binary is better than shipping a runtime.
3. **F17 + N9: strict, deterministic verification over raw git objects.** SSH signatures can be verified by calling `ssh-keygen -Y` or by a well-reviewed library. Calling the `git` and `ssh-keygen` binaries keeps exact compatibility with the wire format.
4. **N8: an MCP server** for the skill. Official SDKs exist for TypeScript, Python and Go; Rust has a community SDK.
5. **N3: durable journals.** Atomic file writes with fsync, or embedded SQLite.
6. **N16: the operator's own stack** is Node/TypeScript (zx, the reference client), which matters for op on the laptop.

The runner (Linux, privileged, small, security-critical) and op (macOS, interactive, the operator's own tool) differ. They may reasonably use different languages over the shared wire format, which SPEC and the second implementation already prove is language-independent.
