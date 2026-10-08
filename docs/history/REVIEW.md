> History, kept whole: codex's review of that draft; its findings are folded into the specs or listed as open in DECISIONS.md.

# Review: non-obvious problems of the task workspace

Three rounds between Claude and Codex over `DESIGN.md` (`tmp/claude2codex/017`–`021`), at the operator's request: "find all the non-obvious problems". It is a design review. Nothing listed here has been implemented or tested against a running system; the few git behaviours marked *reproduced* were checked in throwaway repositories (git 2.54).

Severity:
- **B**: a v1 blocker for the stated guarantees. "B if enabled" means the capability stays off in v1.
- **M**: must have for normal operation.
- **L**: later, with the limitation stated.

## Git and the shared branch

| Id | Problem | Sev | Where handled |
|---|---|---|---|
| R1 | A rebase changes the shas of unpublished commits, but a `Re: <sha>` written inside a draft keeps pointing at the old sha (*reproduced*) | B | DESIGN §Work: publish before referring; auto-rebase only drafts with published references |
| R2 | One-writer validity from SPEC does not fit a shared branch. A fast-forward push can still add a merge commit | B | DESIGN §Validity: one parent, typed operator authority, branch-aware freeze |
| R3 | Participants keep pushing between archive and delete; an unconditional delete loses unarchived work | B | DESIGN §Close: fence, archive, then `--force-with-lease` delete with refspec (*reproduced*: without a refspec `--delete` fails) |
| G2 | A peer's `.gitattributes` triggers a filter already configured on the runner (e.g. a global git-lfs) during checkout, even with hooks off (*reproduced*) | B | Isolated runner git env: `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_NO_REPLACE_OBJECTS=1`, no filters, helpers or hooks; raw-object verification |
| C1 | A peer commits `zurich/notes.md -> ~/.ssh/authorized_keys`; zurich's model writes "its notes" through the link | B | Symlinks and gitlinks refused before materialization; byte-only staging (K1) |
| C2 | `.gitmodules` from a peer points at an attacker URL | B | Submodules refused; disabled in v1 |
| C3 | Case-insensitive and Unicode-normalizing filesystems (the laptop's macOS) collide paths like `Zurich/` and `zurich/` | M | Validate every exported path and collision set |
| C4 | One participant pushes gigabytes and fills peers' 10 GB VMs; the archive grows forever | B | Caps on transport, objects, extraction and retained total, at every receiver (origin is untrusted). Compaction later |
| C5 | Shallow clones cannot verify back to the task anchor | M | Full task history in v1; verified checkpoints later |
| C20 | Forgejo `*` does not cross `/`, so it is not a catch-all for `task/9999` | B | `**` default-deny plus exact task rules, tested on the deployed version |
| C21 | Leftover allow-rules re-grant a future branch with the same name | M | Clean up only once default-deny is in force; never reuse ids |

## Authority

| Id | Problem | Sev | Where handled |
|---|---|---|---|
| N3 | A participant edits allocations in `TASK.md`, the operator later signs an unrelated comment, and "latest operator-signed manifest" turns the edit into a grant | B | K2: only typed control records carry authority |
| C6 | origin renames `task/42` to `task/77`; there is no tombstone for 77, so the task runs again | B | The id comes from the signed manifest, never from the ref name; dedupe by signed identity |
| C7 | A task signed by the same root replays into another network | B | The task is anchored to the pinned network (genesis) |
| C8 | Participant removal must not erase valid earlier work, and must not leave live attempts running | B | Typed control plus K5 |
| C9 | A laptop restored from backup reissues an id that was already used | B | Collision-resistant ids, epochs, closed-id memory; ids constrained in refs, paths and rules |
| N12 | Runners on different versions read the same signed file as different budgets or memberships; mirrors get confused with new domains | B before enabling | A protocol and control version, fail closed on unknown authority fields, caches scoped by network and task |

## Keys and sandboxing

| Id | Problem | Sev | Where handled |
|---|---|---|---|
| C10 | "The model holds no keys" is false when the model has a shell as the same Unix user | B | K1: a separate user or container, an inaccessible key and agent socket, a narrow RPC |
| N1 | The privileged runner becomes a signing and read oracle (`put /home/runner/.ssh/id`) | B | K1: identity bound to the session, byte-only `put(bytes, logical_name)`, only measured facts are attested |
| C11 | The root key on the laptop shares the machine with AI sessions and a browser | B isolation / M hardware | A trusted signing path that shows the exact operation; `ed25519-sk` where verifiers support it |
| N2 | Peer content that agents auto-load acts as configuration or code: `AGENTS.md`, `CLAUDE.md`, skill files, build scripts, test plugins | B | The authoritative skill lives outside peer content; builds and tests run sandboxed, without host credentials |

## Execution, budget, liveness

| Id | Problem | Sev | Where handled |
|---|---|---|---|
| N5 / C17 | One attempt means several wake-ups; a peer's message must not mint a new run | B | K3: an attempt is a bounded series of turns, events only queue |
| N4 | Crashes at RPC, publication or effect boundaries cause duplicates or lost operations | B | Request ids, a durable outbox, no blind retry of effects |
| C24 | A VM restored from a snapshot or cloned mid-turn replays paid turns | B | Operator decision below: broker vs managed restore |
| N7 | Fencing pushes stops publication, not a running model; "terminal" is not "settled" | B | K5: closing → settled; execution and accounting tracked apart; an independent settlement channel |
| C14 | Subscription providers (codex with ChatGPT auth) report no cost | B for budgets | Enforceable units: invocations, wall time, tokens when available; cost recorded as unknown |
| C15 | Tasks sharing one provider account starve each other, across VMs too | M | Account-scoped accounting, static allocation, bounded queueing |
| C16 | Self-coordinating agents duplicate work or deadlock | M | Roles, a lead, a watchdog that ends in blocked/input-required |
| C18 | A runner that was offline during close comes back with unpushed work | M | Durable outbox; the settlement channel |
| C19 | Clock skew affects expiry | B for expiry | Separate execution expiry, monotonic duration, delivery deadlines |

## Data and surfaces

| Id | Problem | Sev | Where handled |
|---|---|---|---|
| C12 | Secrets have no channel: the shared branch is read by all participants and the admin | B if needed | Disabled in v1; later a broker or encryption to one agent |
| C13 | External effects (PRs, deploys) need fencing per attempt | B if enabled | Disabled in v1; results are proposals the operator applies |
| N8 | A participant adds a Forgejo Actions workflow that runs on push and bypasses the signed-run gate | B if enabled | Actions disabled on the bus repo |
| N9 | The model's provider, tool servers, caches and traces also receive the plaintext | B for sensitive | Providers and tools scoped per task; sensitive data out of scope for v1 |
| N10 | Deleting a branch is not erasure. A leaked secret survives in archives, clones and provider logs | M | Declared retention; rotate leaked secrets; no promise of global erasure |
| N11 | External pointers and review surfaces (archives, PDFs, HTML previews, terminals) parse hostile content | M | Pointers disabled; rendering limited and escaped |
| C22 | One untrusted origin can censor a participant | L | Bounded retries and visible delivery failures; no stronger claim |
| C23 | The operator is the review bottleneck, and producer-written tests can mislead | M | Bind criteria, revision and environment; verify in isolation |

## Operator decision on C24/K3

Autonomy over strict metering: the laptop stays out of the execution path. VMs are never cloned or restored from snapshots, only re-provisioned with a new key; attempts are bound to the key, so a re-provisioned worker inherits no in-flight attempt. Residual double-spend is bounded by per-VM provider keys with hard spend limits (and plan caps for subscription agents). Exactly-once admission is not promised; a separate always-on broker VM is the upgrade path. See DESIGN.md, "Decided: autonomy, with bounded damage".
