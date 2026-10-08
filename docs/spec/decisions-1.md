# Decisions and budgets, capability `decisions/1`

Work that costs goes the ringi way (稟議): a proposal circulates to named reviewers, who stamp it; the named decider
decides; an approval with a budget is a **grant** that work spends. A company's approval-authority rules (決裁規程)
say who decides what, up to which amount; here that is the hub's authority table. All records are ordinary messages
(core-1 §3); one whose trailers below are wrong is malformed and routes nowhere.

## Records

| Kind | Trailers | Meaning |
|---|---|---|
| `proposal` | `Decider: <id>` (required), `Reviewers: <ids>`, `Due: <ISO time>`, `Budget: runs=<n>[, run-seconds=<n>][, concurrency=<n>]`, `Supersedes: <proposal>` | Objective, scope and acceptance in the body. `To` names the reviewers and the decider. |
| `stamp` | `Re: <proposal>`, `Stamp: approve \| object \| abstain` | A named reviewer's opinion on that exact revision; the subject is the reason. A reviewer's latest stamp counts. |
| `decision` | `Re: <proposal>`, `Decision: approved \| rejected \| revoked`, `Control: <control entry>` | Only the named decider, and only with authority. The first `approved` or `rejected` is final; `revoked` (by the decider or the root) ends an approval's grant. |
| `usage` | `Grant: <decision>`, `Usage: reserve \| settle`, `Run: <run id>`, `Seconds: <n>`, `Exit: <n>` | Receipts written by the runner that starts model runs, never by a model. Hidden from inboxes. |
| any message of a piece of work | `Grant: <decision>` | The work spends that grant. A later `Grant` from whoever the profile's `grant` rule allows replaces it (a top-up). |

## Rules

- **Ranks.** The **root** (`operator`) changes a room's members, decides without limit where it is the named decider
  (its own proposals included), and revokes any approval. A **lead** (a label the profile may give) decides within its work and within the
  budget granted to it, and changes roles and assignees as the profile allows. A **member** proposes, stamps with a
  reason, and works.
- **Authority.** Anyone but the root decides only within the authority table in effect at the control entry the
  decision names (`Control`). The table is the hub's `authority.json`:
  `{"decide": {"<id>": {"runs": n, "run-seconds": n, "concurrency": n}}}`, the largest budget each may approve. A room
  follows the table of its contract base until `room rebase-contract`. Nobody but the root decides their own
  proposal. Only the named decider approves or rejects; naming a decider grants no authority.
- **Authority is bound to the decision.** A control entry that does not exist yet cannot be named, so adopting a
  contract later never activates an earlier decision, and changing the table never promotes an unauthorized decision
  or demotes a valid one. A decision may cite any earlier control entry, so taking authority away is prospective only
  for honest clients; the root cuts a dishonest decider off with `revoked` and by not admitting it.
- **Revisions.** A proposal with `Supersedes` from the same author (or the root) replaces the old one: stamps do not
  carry over, and the old one can no longer be decided. A grant already issued for the old revision stays limited to
  its scope until revoked.
- **Silence.** After `Due`, missing stamps are reported as missing. Silence never approves.

## Budgets and the ledger

- `runs` is required. Every reservation counts as a run, settled or not, so a crash never refunds. `run-seconds`
  bounds one run: the runner stops it there, settles it, and does not retry it, since the cap was the decider's.
  `concurrency` bounds unsettled reservations. A turn that fails otherwise is retried, each attempt a new run.
- **The ledger** of a grant, in thread order: every `reserve`, and for each run (its runner and `Run` id) the first
  `settle` after that run's `reserve`. A receipt whose `Grant` names no grant, a second settlement, and a settlement of
  no reserved run count nothing.
- A grant whose runs are spent, or that was revoked, starts nothing; the runner answers the work with the profile's
  `waiting` state and waits for a new grant. A top-up is a new grant named in a later reply; the old ledger stays.
- The journal is the truth. Counted receipts also carry signals (`usage.reserve`, `usage.settle`,
  [signals-1](signals-1.md)) for tools; a missing or deleted signal changes no accounting.
- **Limits.** A reservation is atomic only where the runners share one lock (one machine, one local hub). Replication
  alone cannot stop a restored or cloned runner from spending twice: across machines, use one enforcing runner per
  grant, or an external meter. Token and money limits need a metering adapter that can enforce them; they are not
  part of `decisions/1`.

Changes: anything that grants or restricts more is `decisions/2`, in its own file.
