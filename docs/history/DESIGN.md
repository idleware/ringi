> History, kept whole: the trusted-workspace draft for agents on separate machines; its signed transport is now hub-1, its runner and budgets decisions-1, the rest open.

# Trusted workspace for multi-agent tasks (draft)

The operator's question: how to build a trusted distributed space where agents on several VMs take tasks, do the work, return results, and the task's branch is deleted.

This merges two independent proposals written blind, Claude's and Codex's (`tmp/claude2codex/009`), plus Codex's cross-review (`011`) and the operator's own steering. SPEC.md is the wire format underneath; this document is the system around it.

## Topology

- **The operator's laptop** is the source of truth:
  - the repository with the full history;
  - the root key, ideally on a hardware key;
  - the coordinator, which is just a laptop-side script;
  - the archive.
- **origin**: an upstream on some VM (Forgejo on amster). It is the meeting point and holds only what is in flight: active task branches, the roster and tombstones. It is disposable and untrusted.
- **Agent VMs**: a runner (code) and a model. The runner holds the agent's signing key, out of the model's reach. It works in clones of what it was granted.

```
 laptop (root, coordinator script, full history, archive)
    │  push task + participants, roster, tombstones; fetch results; delete branches
    ▼
 origin on a VM (in-flight branches only; ACLs; untrusted)
    ▲  fetch the task branch, push to it (rebase, never force)
    │
 agent VMs (runner holds the key, model does not)
```

"The branch is deleted" means deleted on origin. On the laptop the task stays in history.

## Baseline workflow: the operator drives

The operator's own words: "I'll create the task branch myself, list in it the machines (agents) I want to involve, and grant access to that branch only to those agents with a forge script." This is version one. There is no pool and no offers.

1. **Create.**
   - The operator creates the task: `TASK.md`, assets, completion criteria, deadline, and the **participants**, i.e. the agents involved, their roles and **budget allocations**.
   - The allocations add up to at most the task total; moving budget between participants takes the laptop.
   - The commit is signed by the operator and pushed as `task/<id>`.
   - That signed content is the **authorization to execute and spend**: who may act, in which role, within which allocation, until when.
2. **Grant.** The laptop script reads the participants from the operator's signed revision and sets Forgejo branch protection.
   - All listed participants may push to the one shared branch `task/<id>` (the operator's decision).
   - Force-push and deletion are disabled for them; only the operator deletes, at close.
   - Nothing else is nested under the name: git cannot hold a ref `task/<id>` next to refs below `task/<id>/`.
   - A participant editing the list grants nothing: grants come only from the operator's commit or command.
   - Forge ACLs are defense in depth. The signed task is what runners obey.
3. **Run.** The runner on each listed VM checks, in code:
   - the task is signed by the operator;
   - its agent is listed, in this role;
   - its own allocation and the deadline hold;
   - the id is not closed;
   - the attempt `(epoch, task, agent, key, role, attempt)` was not already consumed.

   It persists "started", then invokes the model. Webhooks and polls are only hints.
4. **Work and talk.** The participants share `task/<id>` and coordinate themselves.
   - **Non-fast-forward is normal.** The runner handles it, not the model:
     1. It first reconciles a lost push acknowledgement: a commit already in the remote's verified history counts as published.
     2. It fetches, rebases its own unpublished commits (re-signing them) and retries.
     3. Retries are bounded and never rerun the model.
   - **Publish before referring.** A message is published before any other message names its sha in `Re`. A rebase changes the shas of unpublished commits but not the references written inside them. The runner therefore rebases automatically only drafts whose references all point at published commits.
   - **Own folder.** By convention each agent writes under its own folder (`<agent>/…`), which keeps most rebases free of content conflicts. It is a convention, not a guarantee. The runner keeps conflicting work, reports the conflict and never resolves it silently.
   - **Visible, not prevented.** The forge cannot stop a participant from changing another's files in a shared branch. Every commit is signed, so such a change is visible to the review.
   - **Validity** is an extension of SPEC, whose §3 assumes one writer per log. A reader accepts each new commit on `task/<id>` only if all hold:
     - it has exactly one parent; a fast-forward push can still add a merge commit, which is invalid;
     - the history only grows;
     - it is signed by the operator, or by a participant listed in the latest operator-signed manifest revision that precedes it;
     - the task's first commit descends from the pinned network genesis.

     Freezing becomes branch-aware, with one anchor per key per task branch. Cutting a compromised commit out of shared history also quarantines the honest work after it. Recovery is the operator's call; nobody re-signs another participant's commits.
   - Discussion is addressed messages (commits whose `Re` points at others' commits). Receiving one never starts a model by itself.
   - The lead synthesizes the result, and an independent reviewer checks it.
5. **Deliver.** A signed result manifest with artifacts and measured status goes into the shared task branch, under the agent's folder. Delivered is not accepted.
6. **Close.** Nothing is deleted before it is safe, in this order. Each step is idempotent, so an interrupted close resumes where it stopped.
   1. **Fence.** The script revokes participants' pushes, so the branch stops moving.
   2. **Archive.** Fetch `task/<id>` into the durable local ref `refs/archive/task/<id>`, outside the fetch/prune-managed namespaces. Verify that every object is present and the hashes match.
   3. **Receipt.** Sign the acceptance (hashes, cost) and the tombstone, and persist both locally.
   4. **Backup.** Complete an independent backup of the laptop that contains those refs and records, or have the operator explicitly accept the loss window instead.
   5. **Publish.** Push the tombstone to origin's control history (`main`), so runners refuse the closed id.
   6. **Delete.** Run `git push origin --delete --force-with-lease=refs/heads/task/<id>:<archived sha> refs/heads/task/<id>`. `<archived sha>` is the persisted full object id, not a tracking ref. If the head moved anyway, go back to step 2.
   7. **Unprotect.** Remove the branch's protection rule, so no stale allow-rule grants a future branch of the same name.

**Retries** are deliberate and per participant: the operator grants that participant attempt *n+1*. A reviewer can be rerun without rerunning the implementer. A superseded attempt cannot deliver. A cut-off VM may keep computing, so gateways for external effects enforce expiry and attempt numbers themselves.

## Agent interface: a skill over a privileged runner

The protocol reaches agents as a tool, never as raw git (the operator's direction). Two layers:

- **The runner** is privileged. It runs as its own Unix user (or outside the model's container) and holds the signing key and the forge token. It does everything that must not be left to a model:
  - fetch, verify, sign, push, rebase and retry;
  - publish messages before anything refers to them;
  - refuse symlinks and submodules;
  - check budgets and tombstones, and persist reservations;
  - wake the model.
- **The skill** is what the model sees: a short instruction file plus a few commands that ask the runner over a local socket. The same commands work for every vendor, as a CLI, an MCP server, or a Claude or Codex skill:
  - `task show`: the manifest, own role and allocation, messages addressed to me;
  - `task say --to <ids> [--re <msg>]`: an addressed message;
  - `task put <path>`: a file into my folder;
  - `task state working | input-required | completed | failed`;
  - `task ask-operator`.

  The model never sees keys, git or other tasks. Peer content reaches it marked as data from a named participant, never as instructions.

Most non-obvious problems found so far live in the runner by design: rebase and `Re`, symlinks, key isolation, close fencing. The skill keeps them out of the model's hands.

## Contracts

These came out of three review rounds. The full problem catalog is [REVIEW.md](REVIEW.md).

**K1. Runner session.**
- **Identity.** The runner opens a session only from a verified control record. The session's identity is (network, epoch, task, agent, role, attempt), and the model never supplies it. Permissions and session state are checked on every call.
- **What the model sends.** Bytes only: `put(bytes, logical_name)` into runner-owned staging, with validated destination components. Never a host path. `O_NOFOLLOW` guards only the last path component.
- **What is signed.** The runner signs immutable snapshots of its staging. It attests only what it measured (exit status, wall time, spend). A model's "completed" or "tests passed" travels as a claim.
- **Isolation.** One sandbox per task.

**K2. Typed control.**
- Authority changes only through an operator-signed control commit: `Kind: control`, `Version: 1`, `Grant: <id>`, `Manifest: <blob sha>`. The blob must match the manifest file in that commit's tree.
- The signed envelope covers network, task, epoch, participants, roles, attempts, control revision, budget units, expiry and grant id.
- Parsing is strict: duplicate keys or trailers, and unknown authority fields, are rejected. Re-applying a grant never resets consumed counters.
- Ordinary operator commits grant nothing. Acceptance names the exact commit and artifact hashes.
- The operator's signing script shows the typed operation and the manifest hash, since a signature proves key use, not review.

**K3. An attempt is a bounded series of turns.**
- A grant limits turns, wall time, spend units and deadline. The runner keeps a journal: state, consumed spend, event cursor, and an outbox keyed by request ids.
- A reservation is persisted before every turn. A crash leaves the turn consumed and uncertain: never rerun automatically, never refunded.
- Messages queue and are coalesced. There is never a parallel session for one attempt.
- A receipt acknowledged by origin is **not** trusted durable accounting. Codex's counter-traces: origin drops the receipt while the VM rolls back; a snapshot taken after the token check is cloned and spends twice. See the decision below.

**K4. Poisoned shared history.**
- Readers stop at the first invalid commit and quarantine the rest. Runners never rebase onto an unverified tip.
- Recovery is a new task, whose control record names the old branch's last valid commit as salvage evidence and grants afresh. Participants republish only their own content. Old `Re` links need provenance or remapping.
- The old branch closes through a separate **rejected closure**: last valid prefix, fetched head, reason, raw evidence within caps. Never through a normal acceptance.
- Freezes default-deny branches that have no anchor.

**K5. Closing and settlement.**
- `closing` fences pushes and cancels: no new turns start, and a running turn ends within its hard cap. Fencing publication and ending execution authority are distinct acts.
- An independent settlement channel survives the fence and the branch deletion: the operator pulls runners' outboxes, or a scoped status endpoint accepts only receipts. Otherwise the final usage reports could not get out of a fenced branch.
- Execution and accounting are tracked apart: `terminal + settled`, or `terminal + uncertain/reserved`. Worst-case in-flight reservations are kept until reconciled; allowance is never reallocated before then.

## Disabled in v1

- Forgejo Actions on the bus repository; webhooks are only hints.
- External effects: results are proposals the operator applies.
- Symlinks, submodules, LFS and external pointers.
- Pools and claims, mirrors and multiple repositories.
- Secrets through the bus.
- Builds and tests with network or credentials.
- Sensitive data: providers and tool servers also see the plaintext.

## Decided: autonomy, with bounded damage

The operator: "Autonomy loses its meaning if the laptop has to be kept on all the time." The laptop is not in the execution path:

- **The laptop is needed only at human moments:** create a task, accept and close, decide a retry or a recovery. Execution runs on pre-signed grants with allocations and deadlines, and continues while the laptop sleeps.
- **Bounded delegation.** If agents should spawn subtasks or retries on their own, the operator's control record gives the lead an envelope: budget, allowed participants, depth. The lead acts inside it without the laptop and cannot exceed it.
- **Rollback and clone protection comes from an external, non-rollbackable meter that already exists: the provider.**
  - Each VM gets its own API key with a hard spend limit (Anthropic: workspace spend limits in the Console; OpenAI projects: to be checked). Subscription agents (codex with a ChatGPT plan) are capped by the plan.
  - **VMs are never cloned or restored from snapshots** (the operator's rule). A broken or suspect worker is always re-provisioned from scratch with a new key. The root revokes the old key and freezes it at its last accepted work.
  - **Attempts are bound to the key, not just the agent's name:** `(epoch, task, agent, key, role, attempt)`. A re-provisioned VM under the same name has no journal, so it inherits no in-flight attempt. Those become uncertain, their spend stays consumed, and the operator grants new attempts explicitly.
  - The worst case is overspend up to that key's cap. Exactly-once is not promised.
- **Later, only if exactly-once matters:** a small always-on broker VM with bounded delegated authority, separate from workers and from the forge.

## Acceptance matrix (to be implemented; nothing here has run)

| Invariant | Enforcement point | Test |
|---|---|---|
| A model acts only as its session and submits allowed bytes | RPC auth, sandbox, private staging | Task A can't use B's socket, read host paths, escape via `..` or directory links, or alter a snapshot during signing; claims never become measured fields |
| Only typed control changes authority | Signer script, strict parser, grant ledger | Participant edits manifest plus root comment: unchanged. Wrong blob, duplicate fields, unknown version or fields, wrong task or network: rejected. Replaying a grant does not reset consumption |
| Every accepted commit is anchored and valid | Raw-object verifier, accepted-prefix store | Renames and replays into another task or network; unsigned commits, merges, missing ancestry and freeze gaps stop at the right prefix; nothing rejected reaches a model |
| Materialization runs no inherited machinery | Isolated runner git env | Seeded hooks, filters, helpers, replacement refs and hostile attributes trigger nothing |
| Inputs can't exhaust the runner before authorization | Transport, parser, staging and render limits | Oversized packs, archive bombs, huge object counts, invalid modes and colliding names end within limits; no model runs |
| Published identities and references stay stable | Draft queue, request ledger | Racing pushes, dropped acks and rebases preserve published shas, valid `Re`, and one operation per request id; the same id with a different payload fails |
| Snapshot policy matches the advertised guarantee | External admission ledger, or a declared restore boundary | Snapshots at each boundary, concurrent clones, origin rolled back: at most one billed call in strict mode; offline mode declares the case unsupported |
| Crashes never refund or replay an uncertain spend | Reservation journal, recovery | Crashes at reserve, receipt, dispatch, response and accounting: reservations survive, nothing replays, budgets don't reset |
| Events can't create unbounded turns | Turn state machine, bounded queue | Duplicate webhooks, cycles, fresh threads without `Re` and fan-out consume only authorized turns; one active turn per attempt |
| Cancellation stops new work | Admission gate, session state, trusted expiry | Cancel, remove or expire mid-turn and reuse old sockets and tokens: no new calls, in-flight costs stay reserved |
| Forge permissions cover every write route | Deployed Forgejo policy | Only the active task is pushable by its participants; main, nested refs, tags, force, deletion and stale-name recreation are denied, also after rule cleanup |
| Quarantined history closes without acceptance | Recovery controller, evidence store | Poisoned branch: honest clients stop, rejected closure, fresh recovery task, nothing forced or silently replayed |
| Fencing doesn't block settlement | Settlement channel, accounting ledger | Final report arrives after the fence; a lost provider response stays reserved, not refunded |
| Close preserves exactly what was archived | Close journal, verifier, conditional delete | Crash after every step; head advances; delete ack dropped: changed heads survive and retries reconcile |
| Restore can't resume old authority | Recovery, epochs | Restored ledgers keep issuance stopped until recovery completes; old tokens and closed ids never become fresh |
| Disabled capabilities stay disabled | Forge settings, sandbox, routing | Workflows run nothing; no submodules, LFS, networked builds or external writes; task sessions share no private context |

## Actors and trust

| Actor | Holds | Trusted for |
|---|---|---|
| Root, the operator | Root key, offline or on hardware | Who exists, which roles; tasks, grants, acceptances |
| Coordinator script, on the laptop | Nothing of its own; acts with the operator's signing | Applying grants on the forge |
| Runner, on each VM | The agent's signing key, out of the model's reach; a scoped forge token; local memory | Verifying before anything runs, signing, persisting reservations |
| Model | No keys | Nothing; its output is a claim to review |
| origin (Forgejo) | Replicas, ACLs | Availability. Write isolation between tasks: only a task's listed participants can push its branch, and nobody force-pushes. Inside a task, participants can touch each other's files; signatures make that visible. Read access is per repository: in the shared repository of the baseline, every participant can read every task branch. Not authenticity; not confidentiality from its own administrator |
| Laptop repo and its backup | Full history: tasks, results, receipts | Being the source of truth |

## What each side must remember

- **Runners** keep durable local memory, outside disposable clones:
  - closed task ids;
  - consumed attempts;
  - the newest authority they have seen.

  A hostile origin can drop a tombstone or replay an older, validly signed view; a runner's memory catches what it saw before. A fresh or restored runner cannot tell old from current history by itself. It stays idle until the laptop gives it a fresh authorization bound to its new session.
- **The laptop** is the authority, so restoring it from a backup is an authority rollback. The backup may predate grants, spent budget, cancellations and attempt counters. Recovery therefore:
  1. stops new grants;
  2. reconciles with runners' durable records and receipts;
  3. starts a new authority epoch;
  4. lets old outstanding grants expire, or revokes them at the gateways.

## The laptop sleeps

Nothing needs authority on a VM if the operator accepts this:
- grants already issued keep running offline, within their participants, budget and deadline;
- new tasks, retries and acceptances wait for the laptop;
- a cancellation reaches a disconnected worker only when it reconnects; gateways bound the damage by expiry.

A VM may host delivery and notifications, but never grant authority.

## Failure and compromise

| Event | Lost | Detected by | Recovery |
|---|---|---|---|
| A VM compromised | The plaintext of its tasks, its scoped credentials. It can sign false claims about its own work | Review; receipts | Quarantine its identity and unreviewed results, revoke, rebuild the VM, rerun explicitly |
| origin wiped | Anything that lived only there: progress pushed since the laptop's last fetch that no runner still holds | Runners see missing refs | Re-provision. The laptop re-pushes roster, tombstones and open tasks; runners re-push their branches. Only what the laptop or a surviving runner holds comes back |
| origin lies: rollback, withholding, replay | Availability | Runner and laptop memory; independent checkpoints. The forge's own seals cannot prove freshness, since the forge controls the sealer | Repair from replicas; nothing unsigned is accepted |
| origin's admin reads | Today: all task content and metadata | — | Only encryption before upload, with keys origin never sees, protects content; it is not built yet |
| A participant reads others' tasks | In the shared repository: every task branch | — | Separate repositories per agent or per group give read isolation between ordinary accounts. Neither layout hides anything from origin's admin |
| Laptop offline | New grants and acceptances | — | In-flight grants continue within bounds |
| Laptop restored from a backup | Authority state since the backup | Reconciliation | A new epoch, as above |
| Root key | Authorization itself | — | Stop issuance. Re-pin a new root out of band; a successor signed only by the old root is not enough |

**Trust boundary today:**
- origin and its administrator see everything in plaintext, metadata included;
- what they cannot do is forge, or make a runner act on something the operator did not sign.

## Keys (decided)

1. **Generate on the VM.** The agent generates its key pair at provisioning. The private key never leaves the VM: no bundle carries it and no backup holds it.
2. **Admit.** The operator takes the public key over the provisioning channel, and the root puts it in the roster on `main`, the truststore signed by the root.
3. **Anchor.** The agent gets the root public key and the genesis from the operator at provisioning, never from origin. They are its anchor for trusting the repository and everything the root signs. Through the roster it then trusts the other agents' keys.

A signature proves use of the private key, not a particular machine or correct execution.

## The operator's day

1. `task new ./task-dir --agents zurich:implementer:0.3,amsterdam:reviewer:0.2 --deadline 2d`: signs, pushes and grants. Each participant has a role and an allocation.
2. `task list`: queued, working, blocked, review.
3. `task reply <id>` or `task cancel <id>`.
4. `task review <id>`, then `task close <id>`: archive, receipt, tombstone, revoke grants, delete on origin.
5. `task retry <id> <agent>`: always deliberate, per participant.

## Mapping to the signed git binding (v0.3)

- **Already there:**
  - signed per-writer logs, the root-signed roster, freezes;
  - genesis binding;
  - repair from replicas;
  - single-writer assignment;
  - runner-side budgets (`watch`).
- **Missing:**
  - shared task branches `task/<id>` with participants and allocations, multi-writer validity (any listed participant, append-only), the runner's fetch-rebase-retry push, the grant script, resumable closure with tombstones and archive refs;
  - attempt numbers and fencing;
  - runner memory and fresh-authorization bootstrap;
  - authority epochs;
  - encryption;
  - gateways;
  - keeping the signing key out of the model process.
