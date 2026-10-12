# ringi hubs, version 1

How ringi keeps rooms: hubs, their shared contract, the stores under them, the operator's home on each machine,
sessions and their seats, and what a reader trusts. The messages themselves follow [core-1](core-1.md). Any
implementation that reads the descriptor and the store's `contract.json` and follows this file works on the same
hubs: the contract's `version`, not the tool's, decides compatibility. Nothing here depends on Node or npm.

## Terms

- **Operator**: the human, and for now also the root. Their terminal context is a current hub
  and room, kept in the home; it never moves an agent.
- **Hub**: a directory with a **descriptor** (`hub.json`: which store, where, the trust, the pins this machine holds)
  beside its **store**. The store keeps the shared contract, the rooms and the signals. `local` always exists and is
  the default: on this machine, no keys, senders asserted. A signed hub is a replica of a remote, with signatures.
- **Room**: a namespace in a hub for one piece of work, kept until the operator deletes it. Its identity
  is its genesis: the first control entry, written by the root, whose subject is `room <name>` and whose `Room-Id`
  trailer is random. A room deleted and created again is a new room; a history offered under another name is not that
  room. A room has its own roster and carries its profile from the start ([profiles-1](profiles-1.md)).
- **Session**: one chat (Claude Code, Codex, Cursor) that the operator joined to a room as an agent, known by a
  stable handle: `RINGI_SESSION` when set, else the chat's own id where the UI exposes one (`CLAUDE_CODE_SESSION_ID`),
  else the UI process found with `ps` as a last resort. Nothing is written into projects (`AGENTS.md`, `CLAUDE.md` stay untouched).
- **Seat**: one per (hub, room genesis, agent). A session holds it.

## Layout

```
$RINGI_HOME/                         unset: ~/.ringi
  home.json                          {"version": 3}; a home of another version is refused
  config.json                        the operator's terminal context: {"hub": "local", "room": "…"}
  hub/<name>/hub.json                the descriptor: {schema: ringi-hub/2, name, trust, root?, genesis?, store: {type, path, remote?}}
  hub/<name>/store/                  the store; for type git, a repository (store/.git) with the contract checked out
  readers/<hub>/<room-genesis>/<agent>.json   that reader's accepted heads and signals, cursors
  sessions/<handle>.json             {hub, room, genesis, agent, scope, state, since, lastSeen, pid}
  keys/<hub>/<agent>                 agent keys, signed hubs only
```

A git store:

```
refs/heads/main                      the shared contract: contract.json, profiles/, HUB.md
refs/heads/<room>                    the room: one linear branch, a stack of messages like a chat
refs/tags/<agent>.<signal>.<message12>   signals and marks on their message's commit (signals-1)
refs/ringi/accepted/<genesis>/<reader>/<author>   reader-owned pins of each author's accepted last message, so gc never erases evidence
```

A room's branch starts on the contract's head at `room create` with its genesis, the root's commit with the control
files `ROOM.md`, `members.json`, `profile.json` (signed rooms also `allowed_signers`). Every later commit is either a
message, its author's commit, or a **control record**, the root's commit of `Kind: room` (a member joins or leaves, the
room moves to a new contract). The control files are the root's: a message never attaches them, and a reader takes
them from the latest control record, never from the branch's tip. A member's **log** is its own messages in branch
order; the room's order is the branch's.

A message is a commit; its tree is the room's published folder, cumulative along the branch. When a message has
files, the store lists their paths in the trailer `Ringi-Files` (a JSON array). A commit without it carries what its
tree adds or changes over its parent: nothing for a text-only message, the changed paths for records written before
the trailer. An invalid list is refused: the message keeps its place with its files refused, and the room reads on.
A writer commits on the branch's tip and moves it with compare-and-set; when another writer got there first, it makes
its commit again on the new tip. Ref components are agent ids (core-1 §1), valid git ref names and file names;
`operator` is reserved. A new store type implements the same port (docs/ARCHITECTURE.md).

## What a store guarantees

A store type is an adapter of the `Store` port (core/hub/ports/store.ts), split by what each part does:

| Part | What it does | Required |
|---|---|---|
| Log | the shared contract; rooms and their control records; each member's log; `extends` | yes |
| Attachments | files stored for messages, and what a member staged for its next one | yes |
| Signals | immutable markers on messages (signals-1) | yes |
| Evidence | what a reader accepted, kept reachable | yes |
| Administration | delete a room | yes |
| Verification | why history may not be accepted; nothing for asserted senders | yes |
| Presence | one heartbeat per agent and room, replaced on every beat | no |
| Signed | the root, members' keys, a transport alarm forgotten after review | signed hubs |

Order alone is not enough. A log guarantees:

1. **Identity.** A room, a control record, a message and an author's log have ids that do not change; a room made
   again is another room.
2. **Immutable content.** What a message said, who wrote it and what it carries never changes under its id.
3. **Replay with an outcome.** Reading on from what a reader accepted says whether it continues, is unreachable for
   now, lost a range, or no longer extends it; a gap in a cursor alone proves nothing.
4. **Evidence.** What a reader accepted stays reachable, or the store says why it cannot.
5. **Idempotent append.** A write whose result is unknown can be made again without a second message, or the store
   says how to reconcile it.
6. **Concurrency and failures.** Two writers on one room do not overwrite each other (compare-and-set), and a failure
   says what kind it is.

`src/test/ts/store-contract.ts` checks these and the required parts over any store type; the git store passes it
(`store.test.ts`). A backend that cannot give one of these needs a replica that does: a Telegram group keeps a bot's
updates a day and may drop messages, so it needs its own replica and checkpoints; Kafka orders within a partition
only.

## The contract and its versions

- **Genesis.** The contract's first version holds `contract.json`
  (`{"schema": "ringi-hub", "version": "1.2", "protocol": 1, "trust": "asserted", "store": "git/2", "capabilities": ["profiles/1"], "profile": "a2a-1"}`),
  `profiles/a2a-1.json` and `HUB.md`. A signed hub adds its root key and signs every version with
  it. `store` names how the store lays out what it keeps; for a contract without it (before 1.2) the store type looks
  (a git store with room branches under `<room>/` is ringi 0.1's, `git/1`, and refused).
- **Versions.** `version` is major.minor. A minor only adds optional data without authority; older tools keep reading
  and writing. Anything that grants or restricts is a required capability (core-1 §8) or a major. A tool refuses a
  hub or a room whose contract major, protocol major, capabilities or store layout it does not know, and says what to
  do: upgrade the tool for a newer hub; for an older one, make a new hub beside it or a new root branch on a forge.
  Nothing is migrated. A retired capability (`decisions/1`) stays known and restricts nothing, so a contract that
  names it opens; a room that holds its records is not supported: it reads on, its records as plain messages and
  their signals as ignored alarms, until the operator starts a new room.
- **Amending.** `ringi hub amend` changes version, capabilities, the default profile and profiles (each checked
  before it lands). A room follows the contract as of its base until the operator moves it (`ringi room
  rebase-contract <room>`, a control entry naming the new base) or deletes it.
- `ringi --version` prints the tool's version and the majors it reads.

## A room's life

1. `ringi room create fix-badge`: the room's branch with the operator as first member and the profile copied in;
   it becomes the terminal's current room. With `--quorum <n>` (a `Quorum` trailer of the genesis) the room's work
   starts by itself once it has n agents: until then a join or an inbox reads nothing and says it waits; from then on an agent takes its first turn without asking the operator, the room's work for it being
   its scope when none is recorded. `--quorum 1` starts at once.
2. In each chat the operator wants in, the operator says who it is and what to accept: *"join fix-badge as codex;
   review tasks from operator and claude; no commits"*. The skill runs `ringi join local fix-badge --as codex --scope
   "…"`: the agent enters the roster on the operator's word in that chat and the session is bound. A peer's message
   can never add a member or widen a scope.
3. Work: `ringi send`, the agents' turns (`ringi agent inbox`, `ringi agent reply …`), `ringi where`.
4. Pause: *"stop"* runs `ringi stop`; the seat stays, the agent reacts to nothing until `ringi continue`.
5. A closed laptop or a dead process is not a stop: the lease lapses and `where` shows the session **gone**. A gone
   or stopped binding keeps its seat and scope; a lapsed lease never hands them to another chat.
6. Resume: *"continue"* in the same chat re-binds its record, shows its scope and reads the inbox. In a new chat
   `continue` lists the candidates; naming one (`ringi continue fix-badge/codex`) is the operator's explicit takeover.
   It never picks by product and never takes a seat a live session holds. A plain `join` starts a fresh delegation.
7. Exit: *"leave"* releases the seat; the agent stays in the roster until the room ends.
8. End: `ringi room delete fix-badge --yes` erases it, irreversibly: its branch, every tag on its commits, every ref the store keeps under
   its genesis (pins, evidence), its unpublished commits and its readers' state; git objects are left to the
   repository. Without an id it takes the room of the current context. The room's branch is gone, and
   every session bound to it, on this machine or another, leaves its seat on its own when it finds that.
   A hub that cannot be reached is not a gone room: it fails, and waiting or retrying is the orchestrator's concern.

## Commands, seats and locks

Three namespaces, all in one generated table ([COMMANDS.md](../../COMMANDS.md)): **operator** commands in a terminal,
in the operator's context; **session** commands in a chat, on the operator's words; **agent** commands during a turn,
always as `ringi agent …` and always in the session's own hub and room. An agent command refuses when the session is
not joined, is stopped, or its room is gone, and names the session command to run.

- `join`, `continue`, `stop`, `leave`, lease renewal and takeover go through one lock with compare-and-set on the
  seat record, so a resumed session cannot overwrite a takeover. `join` of another room releases the old seat in the
  same step: one room per session.
- Locks are files with an owner. Live or unreadable owners are never evicted by age; a dead owner is recovered under
  a gate; if the gate's owner dies, ringi stops and names the gate to remove.

## The home and sandboxes

All sessions on a machine write one home. Measured with `codex sandbox -P :workspace` (Codex CLI 0.162) on macOS:

| location | writable from the sandbox |
|---|---|
| the project (cwd) and its `node_modules/.cache` | yes |
| `node_modules/.cache` of the global npm prefix | no |
| `~/.ringi`, `~/.codex` | no |
| macOS `~/Library/Application Support`, `~/Library/Caches` | no |
| XDG `~/.local/share`, `~/.local/state`, `~/.config`, `~/.cache` | no |
| `$TMPDIR`, `/tmp` | yes, but the system clears them |

No durable place shared across projects is writable with standard grants, and a per-project home would keep agents
in different directories apart. So the home is one place with one grant:

- **`RINGI_HOME` names it**; unset, `~/.ringi` on every system, one path without spaces to name in a grant.
- **The grant.** When ringi cannot write the home it fails with a fixed message: the agent re-runs the same command
  with its host's sandbox escalation, which the operator approves; or the operator adds the home once to the host's
  writable roots (Codex: `[sandbox_workspace_write] writable_roots` in `~/.codex/config.toml`). ringi prints that line
  and changes no host configuration.
- ringi never falls back to a per-project or temporary home. An explicit session handle never depends on `ps`, which
  a sandbox may deny; only the last-resort fallback does, and where `ps` is denied ringi asks for `RINGI_SESSION`.

## Trust

- **local**: senders are asserted; whoever can write the repository could write as anyone, `operator` included. A
  message from `operator` is a request, not the human's authority; the authority is what the operator said in the
  receiving chat, recorded as the session's scope (a reminder, not a credential). Each reader keeps each author's
  accepted last message and pins it with a reader-owned ref; every new one must descend from the accepted one. A
  rewritten branch (an author's messages rolled back or replaced), a recreated room or a room under another name
  raises an alarm and is withheld; after review, only the operator accepts a new baseline (`ringi forget
  <room>/<author>`). Corrupt reader state fails closed. Integrity from first observation, given an intact client; no
  protection from a same-user process that replaces both.
- **Namespaces are not permissions.** Operator, session and agent commands separate intended actions; a process
  running as the same user can call any of them.

## Signed hubs

- `ringi hub create <name> --signed --url <git url>` makes the root key on this machine and prints the line other
  machines run: `ringi hub add <name> <url> --root '<key>' --genesis <sha>`. The root key and genesis come from the
  operator, out of band: a key the hub advertises cannot authenticate itself, and the genesis pin stops another hub
  signed by the same root.
- Each machine makes its agent key at `$RINGI_HOME/keys/<hub>/<agent>` when joining; an unadmitted join prints the
  public key and takes no seat. The operator runs `ringi room admit <agent> '<key>' --room <room>`; the agent joins
  again. Private keys never travel.
- Only the root signs `main` and the control records; each message is signed by the key the room's `allowed_signers`
  assigned to that literal principal at the preceding verified control record, and `members.json` agrees with it.
  Admission never validates earlier messages retroactively. Signals and marks are signed by their actors.
- Reads fetch into staging refs, verify each room's branch along first parents (signatures, encoding, genesis, the
  room's name, the roster), then advance local refs and transport pins. A room whose genesis or a root-signed control
  record is broken, whose branch has a merge (a second parent could hide accepted messages), or whose branch was
  rewritten or deleted, is withheld; a contract branch (`main`) that fails its root signatures stops delivery. Any other commit that is no valid message
  (unsigned, signed by another key than its author's, by someone not admitted when it was written, a change of the
  control files, a control record not signed by the root) is skipped with an alarm, and the room reads on.
- When one unpublished commit loses a push race, the writer fetches and verifies the new tip against the accepted
  history and the room's genesis, keeps the unreturned object under `refs/ringi/unpublished/`, and makes its commit
  again on the new tip. Append returns the final published id; replies and signals use that id. Admission recomputes
  the roster before retrying, retaining concurrent admissions. Retries are bounded to eight attempts. If the remote
  already contains the commit after a lost acknowledgement, its id stays unchanged. A rollback, invalid branch,
  multiple pending commits or another rejected push keeps the local commit and alarms. Pushes name one ref and
  never force. `forget` keeps the displaced head as evidence and never waives a signature. Transport is `file://`,
  `ssh` or `https`; cleartext HTTP and redirects are refused.
- Every git command of a store and its transport has a time limit: 30 s by default, `RINGI_GIT_TIMEOUT_MS` (a
  positive integer) to change it; an invalid value is refused before git runs, and a timeout names the setting.
- Not yet on signed hubs: delete and member removal, key rotation and revocation, freezes, seals, automatic
  repair. A remote can still withhold valid data: signatures give authorship and integrity, not completeness,
  availability or confidentiality.

## Compatibility and acceptance

- A hub without a contract, or with an unknown major or capability, is refused with the version it needs. ringi
  refuses a home without `home.json` and never repurposes what it did not create.
- Two chats of the same vendor join different rooms without taking each other's seats or scopes. Switching the
  operator's hub or room moves no agent. A message from
  `operator` widens no scope. A restarted chat resumes exactly its own binding; an ambiguous `continue` asks; a stale
  session cannot undo a pause, a leave or a takeover. A home the agent may not write, or a denied `ps`, gives an
  actionable error. `npm test` covers each.

Changes: what older tools can keep reading and writing is a minor edit of this file and of the contract; anything
else is version 2.
