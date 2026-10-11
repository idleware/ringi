# ringi hubs, version 1

How ringi keeps rooms: hubs, their shared contract, the stores under them, the operator's home on each machine,
sessions and their seats, and what a reader trusts. The messages themselves follow [core-1](core-1.md). Any
implementation that reads the descriptor and the store's `contract.json` and follows this file works on the same
hubs: the contract's `version`, not the tool's, decides compatibility. Nothing here depends on Node or npm.

## Terms

- **Operator**: the human, and for now also the root: every grant is theirs. Their terminal context is a current hub
  and room, kept in the home; it never moves an agent.
- **Hub**: a directory with a **descriptor** (`hub.json`: which store, where, the trust, the pins this machine holds)
  beside its **store**. The store keeps the shared contract, the rooms and the signals. `local` always exists and is
  the default: on this machine, no keys, senders asserted. A signed hub is a replica of a remote, with signatures.
- **Room**: a namespace in a hub for one piece of work, kept until the operator archives or deletes it. Its identity
  is its genesis: the first control entry, written by the root, whose subject is `room <name>` and whose `Room-Id`
  trailer is random. A room deleted and created again is a new room; a history offered under another name is not that
  room. A room has its own roster and carries its profile from the start ([profiles-1](profiles-1.md)).
- **Session**: one chat (Claude Code, Codex, Cursor) that the operator joined to a room as an agent, known by a
  stable handle: `RINGI_SESSION` when set, else the chat's own id where the UI exposes one (`CLAUDE_CODE_SESSION_ID`),
  else the UI process found with `ps` as a last resort. Nothing is written into projects (`AGENTS.md`, `CLAUDE.md` stay untouched).
- **Seat**: one per (hub, room genesis, agent). A session or a watcher holds it.

## Layout

```
$RINGI_HOME/                         unset: ~/.ringi
  home.json                          {"version": 3}; a version 2 home is moved on first use
  config.json                        the operator's terminal context: {"hub": "local", "room": "…"}
  hub/<name>/hub.json                the descriptor: {schema: ringi-hub/2, name, trust, root?, genesis?, store: {type, path, remote?}}
  hub/<name>/store/                  the store; for type git, the bare repository store/.git
  readers/<hub>/<room-genesis>/<agent>.json   that reader's accepted heads and signals, cursors, run budget
  sessions/<handle>.json             {hub, room, genesis, agent, scope, state, since, lastSeen, pid}
  keys/<hub>/<agent>                 agent keys, signed hubs only
```

A git store:

```
refs/heads/main                      the shared contract: contract.json, authority.json, profiles/, HUB.md
refs/heads/<room>/control            the room: ROOM.md, members.json, profile.json; signed rooms also allowed_signers
refs/heads/<room>/log/<agent>        one log per agent; the operator writes as `operator`
refs/tags/ringi/<genesis>/<agent>/<message>.<signal>   signals and marks (signals-1)
refs/ringi/accepted/<genesis>/<reader>/<log>   reader-owned pins of accepted heads, so gc never erases evidence
refs/archive/<room>@<genesis8>/…     an archived room with its signals: read-only, nothing appends, nothing wakes
```

A message is a commit; its tree is the author's published folder, cumulative along the log. When a message has files,
the store lists their paths in the trailer `Ringi-Files` (a JSON array). A commit without it carries what its tree
adds or changes over its parent: nothing for a text-only message, the changed paths for records written before the
trailer. An invalid list is refused: the message keeps its place with its files refused, and the room reads on. Ref components are agent ids (core-1 §1),
valid git ref names and file names; `control` and `log` are fixed segments,
and `operator` is reserved. A room's control starts from the contract's head at `room create`; its logs start from
its genesis. A new store type implements the same port (docs/ARCHITECTURE.md).

## The contract and its versions

- **Genesis.** The contract's first version holds `contract.json`
  (`{"schema": "ringi-hub", "version": "1.1", "protocol": 1, "trust": "asserted", "capabilities": ["decisions/1", "profiles/1"], "profile": "a2a-1"}`),
  `authority.json`, `profiles/a2a-1.json` and `HUB.md`. A signed hub adds its root key and signs every version with
  it. Hubs made before the rename carry the contract as `hub.json`, still read.
- **Versions.** `version` is major.minor. A minor only adds optional data without authority; older tools keep reading
  and writing. Anything that grants or restricts is a required capability (core-1 §8) or a major. A tool refuses a
  hub or a room whose major it does not know, and says which version it needs.
- **Amending.** `ringi hub amend` changes version, capabilities, the default profile, the authority table and
  profiles (each checked before it lands). A room follows the contract as of its base until the operator moves it
  (`ringi room rebase-contract <room>`, a control entry naming the new base) or archives it.
- `ringi --version` prints the tool's version and the majors it reads.

## A room's life

1. `ringi room create fix-badge`: the control branch with the operator as first member and the profile copied in;
   it becomes the terminal's current room.
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
   Hand-off: the chat that holds a seat may hand it to a watcher for headless turns, `ringi watch <room>/<agent>
   --handoff --exec …` run from that chat: the watcher takes the seat with its scope; `stop` and `leave` in that chat
   reach the watcher; plain `continue` in that chat takes the seat back once the watcher has ended. A seat another
   chat holds is never taken.
8. End: `ringi room archive fix-badge` moves the room under `refs/archive/`, ends its seats and watchers, keeps it
   readable. `ringi room delete fix-badge --yes` is separate and irreversible.

## Commands, seats and locks

Three namespaces, all in one generated table ([COMMANDS.md](../../COMMANDS.md)): **operator** commands in a terminal,
in the operator's context; **session** commands in a chat, on the operator's words; **agent** commands during a turn,
always as `ringi agent …` and always in the session's own hub and room. An agent command refuses when the session is
not joined, is stopped, or its room is archived, and names the session command to run.

- `join`, `continue`, `stop`, `leave`, lease renewal and takeover go through one lock with compare-and-set on the
  seat record, so a resumed watcher cannot overwrite a takeover. `join` of another room releases the old seat in the
  same step: one room per session.
- A watcher (`ringi watch <room>/<agent> --exec …`) holds the seat of an agent and starts its headless turns. It
  checks the grant and spawns under the same locks as decisions and session changes: a completed `stop` or
  revocation prevents the next start; a started turn ends with its run-seconds, descendants included. A failed turn
  is retried with the same messages (core-1 §6); one stopped at its run-seconds is not. `watch --once` exits with the
  failed turn's status.
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
  and changes no host configuration. A command-prefix rule for `ringi` is broader than it looks: it would also run
  `ringi watch --exec <anything>` outside the sandbox.
- ringi never falls back to a per-project or temporary home. An explicit session handle never depends on `ps`, which
  a sandbox may deny; only the last-resort fallback does, and where `ps` is denied ringi asks for `RINGI_SESSION`.

## Trust

- **local**: senders are asserted; whoever can write the repository could write as anyone, `operator` included. A
  message from `operator` is a request, not the human's authority; the authority is what the operator said in the
  receiving chat, recorded as the session's scope (a reminder, not a credential). Each reader keeps the accepted
  control head and log heads and pins them with reader-owned refs; every new head must descend from the accepted one.
  A force-update, a deleted log, a recreated room or a room under another name raises an alarm and is withheld; after
  review, only the operator accepts a new baseline (`ringi forget <room>/<log>`). Corrupt reader state fails closed.
  Integrity from first observation, given an intact client; no protection from a same-user process that replaces
  both.
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
- Only the root signs `main` and control; each log is signed by the key the room's `allowed_signers` assigns to that
  literal principal, and `members.json` agrees with it. Signals and marks are signed by their actors.
- Reads fetch into staging refs, verify (signature, linearity, encoding, genesis, the room's name), then advance local
  refs and transport pins. A forged, unsigned, unadmitted, rewritten or deleted log is withheld before delivery; a
  changed control withholds its room; invalid hub authority stops delivery. A rejected push keeps the local commit
  and alarms. Pushes name one ref and never force. `forget` keeps the displaced head as evidence and never waives a
  signature. Transport is `file://`, `ssh` or `https`; cleartext HTTP and redirects are refused.
- Every git command of a store and its transport has a time limit: 30 s by default, `RINGI_GIT_TIMEOUT_MS` (a
  positive integer) to change it; an invalid value is refused before git runs, and a timeout names the setting.
- Not yet on signed hubs: archive, delete and member removal, key rotation and revocation, freezes, seals, automatic
  repair. A remote can still withhold valid data: signatures give authorship and integrity, not completeness,
  availability or confidentiality. Budgets across machines: one enforcing watcher per grant ([decisions-1](decisions-1.md)).

## Compatibility and acceptance

- A hub without a contract, or with an unknown major or capability, is refused with the version it needs. ringi
  refuses a home without `home.json` and never repurposes what it did not create.
- Two chats of the same vendor join different rooms without taking each other's seats or scopes. Switching the
  operator's hub or room moves no agent and no watcher. An archived room is readable and wakes nobody. A message from
  `operator` widens no scope. A restarted chat resumes exactly its own binding; an ambiguous `continue` asks; a stale
  watcher cannot undo a pause, a leave or a takeover. A home the agent may not write, or a denied `ps`, gives an
  actionable error. `npm test` covers each.

Changes: what older tools can keep reading and writing is a minor edit of this file and of the contract; anything
else is version 2.
