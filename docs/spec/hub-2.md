# ringi hubs, version 2

How ringi keeps rooms: hubs, their shared contract, the stores under them, the operator's home on each machine,
sessions and their seats, and what a reader trusts. The messages themselves follow [core-1](core-1.md). Any
implementation that reads the descriptor and the store's `contract.json` and follows this file works on the same
hubs: the contract's `version`, not the tool's, decides compatibility. Nothing here depends on Node or npm.

Version 2 keeps every room in its own store (a git repository, layout `git/4`), so who may read a room is who can
reach its repository. Inside a room, branches carry meaning: the chat, and each agent's own stream of signals instead
of tags. A room is known by its address (Rooms in a space); a machine registers the rooms it knows in its home, of
version 5.

## Terms

- **Operator**: the human, and for now also the root. Their terminal context is a current room, kept in the home;
  it never moves an agent.
- **Hub**: the shared **contract** rooms are made from, with a **descriptor** (`hub.json`: the store type, the trust,
  the pins this machine holds). No command names a hub: `local` keeps this machine's local rooms (no keys, senders
  asserted), and each space has its own signed hub, made with its first room. On an agent's machine a hub is only the
  pins its rooms share, named by the start of its genesis.
- **Room**: one piece of work in its own store, kept until the operator deletes it, known by its **address**:
  `fix` (the same as `local://fix`, in the home), `local:///abs/path/fix` (a directory of the operator's), or
  `<host>://<server>/<space>/<room>` in a space. A bare name selects the one room of that name this machine knows, or
  refuses. Its identity is the address together with its genesis and the hub's: the first control entry, written by
  the root, whose subject is `room <name>`. A room deleted and created again at its address is a new room; a history
  offered under another name, or under another hub, is not that room. A room has its own roster and carries its
  profile from the start ([profiles-1](profiles-1.md)). A machine knows the rooms it was given (created here, or
  joined by their invitation); a store type's listing only suggests others.
- **Session**: one chat (Claude Code, Codex, Cursor) that the operator joined to a room as an agent, known by a
  stable handle: `RINGI_SESSION` when set, else the chat's own id where the UI exposes one (`CLAUDE_CODE_SESSION_ID`),
  else the UI process found with `ps` as a last resort. Nothing is written into projects (`AGENTS.md`, `CLAUDE.md` stay untouched).
- **Seat**: one per (room, agent), the room as this machine registered it: its address, history and repository. A
  session holds it. In a local room a chat takes its tool's name (`claude`; `claude-2` while another session holds
  that seat), or the name the operator gives with `--as`; in a space, the actor its invitation names.

## Layout

```
$RINGI_HOME/                         unset: ~/.ringi
  home.json                          {"version": 5}; a home of another version is refused
  config.json                        the operator's terminal context: {"room": "<address>"}
  hub/<name>/hub.json                the descriptor: {schema: ringi-hub/3, name, trust, genesis, root (signed), store: {type}, contract?: {path}, access? (a space's)}
  hub/<name>/contract/               the contract's store, on the operator's machine; for type git, a repository with the contract checked out
  catalogue/rooms/<id>/registration.json   a room this machine knows, by the hash of its address: the address, the hub it belongs to, and its
                                     endpoint {schema: ringi-room/2, address, name, hubGenesis, genesis, trust, root?, location, store: {path, remote?}, keyRef?, authRef?, hostKeys?}, no secrets
  catalogue/rooms/<id>/invitations.json    in a space, the root's own list of whom it invited (never published)
  rooms/<name>/store/                a local room's store; for type git, its repository (store/.git)
  clones/<id>/store/                 this machine's copy of a room in a space
  room-contexts/<context>/readers/<agent>.json   that reader's accepted heads and streams, cursors, under the room's full context
  sessions/<handle>.json             {room (its address), id, context, genesis, agent, scope, state, since, lastSeen, pid}
  keys/<hub>/operator                a signed hub's root key, on the operator's machine
  keys/realm/<id>/<account>          this machine's key for an account on a host, shared by that host's rooms
  keys/room/<id>/<actor>             a key of one room's own (an actor that came back, a deploy key)
  trash/, room-archives/             what `room delete` moved aside: a room's repository, its registration and lists
```

A room's endpoint pins where its repository is on this machine (the directory and its file-system identity, compared
by inode and birth time: the device number a file system gets when it is mounted may change when the machine
restarts), so a copy or a moved directory is not mistaken for it; its `keyRef` names the key it signs and reaches with, the same one.

A room's git store (layout `git/4`), one repository per room:

```
refs/heads/main                      the contract the room was made with: contract.json, profiles/, HUB.md
refs/heads/chat                      the room: one linear branch, a stack of messages like a chat, with the root's control records
refs/heads/<agent>/signals           the agent's signals and marks, one writer (signals-2)
refs/ringi/accepted/…                reader-owned pins of what each reader accepted, so gc never erases evidence
```

`<agent>/files` is reserved for a later capability; until then a message's files stay in its chat commit. `main` and
`chat` are reserved agent ids besides `operator`. The contract's own store holds `main` alone; a room's `main` is the
contract's history, copied there by the root, so a member needs the room's repository and nothing else, and the hub's
genesis is an ancestor of every room it holds.

The chat starts on the contract's head at `room create` with the room's genesis, the root's commit with the control
files `ROOM.md`, `members.json` (`{"members": {…}, "retired": {…}}`), `profile.json` (signed rooms also
`allowed_signers`). Every later chat commit is either a message, its author's commit (author and committer both), or a
**control record**, the root's commit of `Kind: room` (a member joins, is admitted, or is removed). The control files are the root's: a message never attaches them, and a reader takes
them from the latest control record, never from the branch's tip. A member's **log** is its own messages in chat
order; the room's order is the chat's.

An agent's stream starts on the room's genesis and is linear: each record has one parent, the agent's previous
record. A record names the full room genesis (`Room`) and the control record it is written under (`Control`), which a
reader must have accepted from the chat before the record counts; the stream's place in the chat is what it names,
never its time. Signals and marks are signals-2.

Whether an agent is alive or working is not ringi's to say: it keeps no presence and runs no process of its own. A
quiet session fetches nothing by itself; whoever orchestrates the agents wakes them or polls (`ringi agent wait`). The
skill asks each agent to keep one wake-up of its own host for its room (a Codex heartbeat, a background loop of waits in
Claude Code), backing off from 2 to 10 minutes (30 with nothing open or awaited), and to check on each wake its seat, its inbox, its open work and what it
waits for, once each.
The `<agent>/telemetry` branches of rooms made before 0.10 are left as they are and read by nobody.

A message is a commit; its tree is the room's published folder, cumulative along the chat. When a message has
files, the store lists their paths in the trailer `Ringi-Files` (a JSON array). A commit without it carries what its
tree adds or changes over its parent: nothing for a text-only message, the changed paths for records written before
the trailer. An invalid list is refused: the message keeps its place with its files refused, and the room reads on.
A writer commits on a branch's tip and moves it with compare-and-set; when another writer got there first (in the
chat, or another process of the same agent on its stream), it makes its commit again on the new tip. Ref components
are agent ids (core-1 §1), valid git ref names and file names. A new store type implements the same port
(docs/ARCHITECTURE.md).

## What a store guarantees

A store type is an adapter of the `Store` port (core/hub/ports/store.ts); a `Store` is one room's, opened through
the room's endpoint, and the hub keeps the contract's beside them. The port is split by what each part does:

| Part | What it does | Required |
|---|---|---|
| Log | the room's copy of the contract; its control records; each member's log; `extends` | yes |
| Attachments | files stored for messages | yes |
| Signals | each actor's stream of signals and marks (signals-2) | yes |
| Evidence | what a reader accepted, kept reachable | yes |
| Verification | why history may not be accepted; nothing for asserted senders | yes |
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

`src/test/ts/store-contract.ts` checks these and the required parts over any store type; the git store passes it,
asserted and signed (`store.test.ts`). A backend that cannot give one of these needs a replica that does: a Telegram
group keeps a bot's updates a day and may drop messages, so it needs its own replica and checkpoints; Kafka orders
within a partition only.

## The contract and its versions

- **Genesis.** The contract's first version holds `contract.json`
  (`{"schema": "ringi-hub", "version": "2.0", "protocol": 1, "trust": "asserted", "store": "git/4", "capabilities": ["profiles/1", "rooms/1"], "profile": "a2a-1"}`),
  `profiles/a2a-1.json` and `HUB.md`. A signed hub adds its root key and signs every version with it. `store` names
  how each room's store lays out what it keeps; `rooms/1` is the capability of removing members (Rooms in a space),
  so a reader that cannot do it refuses the hub rather than misreads it. Layout `git/3` (ringi 0.8 to 0.10, home 4)
  and contract major 1 (layouts `git/1`, `git/2`, ringi 0.7 and before) are refused: such a hub stays readable by the
  ringi that made it, in its own home.
- **Versions.** `version` is major.minor. A minor only adds optional data without authority; older tools keep reading
  and writing. Anything that grants or restricts is a required capability (core-1 §8) or a major. A tool refuses a
  hub or a room whose contract major, protocol major, capabilities or store layout it does not know, and says what to
  do: upgrade the tool for a newer hub; for an older one, make a new hub beside it or a new space.
  Nothing is migrated.
- **Amending.** `ringi hub amend` changes version, capabilities, the default profile and profiles (each checked
  before it lands; a contract this ringi would refuse never lands). A room keeps the contract it was made with, a copy
  in its own repository: one task, one room; work under a new contract is a new room.
- `ringi --version` prints the tool's version and the majors it reads.

## A room's life

1. `ringi room create fix-badge`: the room's store (a repository in the home, at the path a `local:///…` address
   names, or in a space through its access adapter) with `main`, and its chat with the operator as first member and
   the profile copied in; it becomes the terminal's current room. Without an address, a random local name. With `--quorum <n>` (a `Quorum` trailer of the genesis) the room's work
   starts by itself once it has n agents: until then a join or an inbox reads nothing and says it waits; from then on an agent takes its first turn without asking the operator, the room's work for it being
   its scope when none is recorded. `--quorum 1` starts at once.
2. In each chat the operator wants in, the operator says what to accept: *"join fix-badge; review tasks from operator
   and claude; no commits"*. The skill runs `ringi join fix-badge --scope "…"`: the agent enters the roster as its
   tool (or as the name the operator gives) on the operator's word in that chat, and the session is bound. An agent
   names a room, never a hub: by its address or name when it is on this machine, by the operator's invitation when it
   is in a space. A peer's message can never add a member or widen a scope.
3. Work: `ringi send`, the agents' turns (`ringi agent inbox`, `ringi agent reply …`), `ringi where`.
4. Pause: *"stop"* runs `ringi stop`; the seat stays, the agent reacts to nothing until `ringi continue`.
5. A closed laptop or a dead process is not a stop: the lease lapses and `where` shows the session **gone**. A gone
   or stopped binding keeps its seat and scope; a lapsed lease never hands them to another chat.
6. Resume: *"continue"* in the same chat re-binds its record, shows its scope and reads the inbox. In a new chat
   `continue` lists the candidates; naming one (`ringi continue fix-badge/codex`) is the operator's explicit takeover.
   It never picks by product and never takes a seat a live session holds. A plain `join` starts a fresh delegation.
7. Exit: *"leave"* releases the seat; the agent stays in the roster until the room ends.
8. End: `ringi room delete fix-badge --yes` takes the room off this machine: its repository in the home is moved aside
   to `trash/`, one at a path of the operator's stays where it is, and its registration and lists move whole to
   `room-archives/`, out of every listing; nothing is erased, and the address is free for a new room. Without an
   address it takes the room of the current context; the sessions bound to it here leave their seats on their own. Any other copy is its owner's to remove: a served repository by `--server` in a
   space, or by its host; another machine's replica and its readers' pins by that machine's operator. A room that cannot be reached is not a gone room: it fails, and waiting or retrying is the
   orchestrator's concern.

## Commands, seats and locks

Three namespaces, all in one generated table ([COMMANDS.md](../../COMMANDS.md)): **operator** commands in a terminal,
in the operator's context; **session** commands in a chat, on the operator's words; **agent** commands during a turn,
always as `ringi agent …` and always in the session's own room. An agent command refuses when the session is
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

## Signed rooms

- A store is reached by its **locator**, a URI whose scheme names the store type: `git+ssh://…`, `git+https://…`,
  `git+file://…` (the part before `+`, or the whole scheme for a type that has its own); the rest is that type's own
  locator. One that names no type is refused, never guessed. A locator is not a room's address: the address says
  which room, the locator where its repository is served.
- From the command line a signed room is always in a space, and its root's invitation carries the pins (Rooms in a
  space): the room's genesis, the hub's genesis, the root's public key and the host's keys, nothing secret. It comes
  from the operator, out of band: a key the room advertises cannot authenticate itself, and the genesis pins stop
  another room or hub signed by the same root. An agent's machine keeps the hub only as the pins its rooms share; it
  never needs the contract's own repository. A program may still make a signed room outside a space through the
  library, its root, `Signer` and transport injected; there the operator's paste of a key into `admit` is the proof.
- Each machine makes the key a room's endpoint names when it joins (`keys/realm/…`, `keys/room/…`); an unadmitted
  join prints the public key and takes no seat. Private keys never travel.
- The default `keys-file` adapter owns those files. The Git transport requires an injected `Signer` for public
  identity and for all commit, admission and signal signatures; for signing it never reads a private-key
  path or falls back to Git's file-key signing (which key an SSH connection uses is the transport provider's to say,
  see Rooms in a space). Returned signatures are verified before any ref moves. Asserted hubs do
  not construct a signer.
- Only the root signs `main` and the control records; each message is signed by the key the room's `allowed_signers`
  assigned to that literal principal at the preceding verified control record, and `members.json` agrees with it.
  Admission never validates earlier messages retroactively. Each stream record is signed by its actor with the key
  admitted at the control record it names.
- Reads fetch a room's repository into staging refs, verify its chat along first parents (signatures, encoding,
  genesis, the room's name, the roster) and each stream (linear, its actor's, named after this room and an accepted
  control record), then advance local refs and transport pins. A room whose genesis or a root-signed control
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
  `ssh` or `https`; cleartext HTTP and redirects are refused. A token in an `https` URL stays in this machine's
  descriptor; ringi never shows it: the URLs it prints, its refusals and its notes (git's diagnostics included) drop
  whatever precedes a URL's host but an SSH login, and the line for other machines carries the URL without it.
- Every git command of a store and its transport has a time limit: 30 s by default, `RINGI_GIT_TIMEOUT_MS` (a
  positive integer) to change it; an invalid value is refused before git runs, and a timeout names the setting.
- Not yet in signed rooms: key rotation, several keys for one actor, freezes, seals, automatic repair. A member is
  removed whole (Rooms in a space). A remote can still withhold valid data: signatures give authorship and integrity,
  not completeness, availability or confidentiality.

## Rooms in a space

A room may live in a space the agents' machines reach: an organisation of repositories on a git host. Its address
names the host's adapter (`core/hub/ports/access.ts`): `forgejo://forge.example/team/fix` is room `fix` in space `team`
(`github://`, `gitlab://`, `gitea://` alike; `gh://` and `gl://` are accepted on input and never stored). Which host it
is matters only to the adapter. ringi has Forgejo's, Gitea's and GitHub's; one for GitLab implements the same port.
Bitbucket Cloud's access keys only read, so it has none.

`ringi room create forgejo://forge.example/team/fix --invite alice,bob` makes the room there; without a room name it
picks one. The first room in a new space also makes its hub, signed: the root key here, and the space's credentials,
checked before anything is made:
- `--token-file`: the API token of the operator's account (a file only its owner reads; ringi never writes one);
- `--host-key-file`: the host's SSH keys as known_hosts lines, which every connection pins. A host that serves them
  over its TLS API, as GitHub does (`/meta`), gives them when the operator names no file, never over an operator's
  pins.
- `--mode account|deploy-key`: how the space's actors reach their rooms, fixed by its first room. By default an
  account where the host can keep an account to its own branch (Forgejo), else a deploy key per room (GitHub). A
  host that cannot do the asked mode refuses it before anything is made; a later room cannot change it.

Later rooms in that space reuse them.

What an access adapter gives, whatever the host:

- a private repository per room, made by `room create`, which publishes the room to it; one that fails after the
  repository is made leaves it private and closed, and creating the room again finishes it under the same name;
- who may push where, enforced by the host:

  | Ref | Writers |
  |---|---|
  | `main` | the root |
  | `chat` | the root and each admitted actor |
  | `operator/signals` | the root |
  | `<actor>/signals` | that actor |
  | every tag | the root, or nobody (ringi writes no tags) |
  | any other branch | nobody |

  each actor through a principal of its own on the host, never the root's. Who may write a control record or sign a
  message stays the room's signed history's to say; these rules only keep the rest out;
- what it reports is what the host reads back: anything wider is refused, never assumed;
- the room's repository deleted on `room delete fix --yes --server`; without `--server`, only this machine's copy.

**Invitations.** Only the root invites, by account: `--invite` at create, `room invite <account>` later. For each
invitee the root's machine keeps an entry in its own list beside the room's registration, never published:
- the mode, realm and account (its stable id and login), or a deploy key's label;
- the actor id the root assigned (the login; the next unused `<login>-<n>` for an account that comes back);
- an invitation id, the address, the genesis and the state.

Each invitee gets one line, `ringi join ringi:…`: `ringi-invite/3`, carrying the mode, the room's address and Git
locator, both geneses, the trust, the root, the host's keys, the principal, the actor and the invitation id. Nothing
in it is secret, and nothing in it is proof. An edited line matches no entry, and the root admits only what its own
list holds. An unknown account, a login that cannot name an actor, or a failing API refuses before anything is made.

**Joining.** The joining machine's key comes from the invitation's mode:
- in account mode, this machine's key for that account realm, reused across the realm's rooms (an actor that is not
  its account's first in the room gets a key of its own);
- in deploy-key mode, the room's own key;
- or an identity file the operator configured with `--identity`.

The same key signs and reaches over SSH, and nothing in `~/.ssh` is read or changed. Being able to fetch the room is
not admission: the roster decides whatever the host lets one read. Until admitted, the join prints the key, and in
account mode *"add this key to <login>'s SSH keys on <host>; then the root runs `ringi room admit <actor> '<key>'`"*.
It exits with 3 and keeps the key and the pending attachment, in a directory of its own, for the retry; nothing is
registered and no seat is taken until the root admitted the key. An access
refusal reads apart from pin, provider, API, configuration and transport failures.

**Admission**, `room admit <actor> '<key>'`, goes in four steps:
1. A read-only check that refuses before any write: the actor is invited and not removed, and the key is no other
   actor's and no retired actor's. In account mode the account's complete key list, read page by page, holds exactly
   this key. A partial or malformed answer, an API failure or an unsupported key type refuses. Nobody's key is put on
   an account for them.
2. A root-signed control record admits the key.
3. The host grants: in account mode the collaborator, the chat and `<actor>/signals`; in deploy-key mode a write deploy
   key, kept by its record id, exact key and room genesis.
4. A readback of the grant.

A failure after step 2 reports the actor *admitted in the room, not granted on the host*, and the same admit again
finishes it without a second record. The host's proof holds at the moment of admission; a key deleted from the
account later rewrites no history.

**Removal**, `room remove <actor>`:
1. A root-signed control record retires the actor: in git/4 `members.json` is `{"members": {…}, "retired": {<actor>:
   {"key", "since"}}}`, its line leaves `allowed_signers`, and `retired` only grows.
2. The host takes back what it can: in account mode the collaborator, the chat and the branch rule; in deploy-key mode
   the deploy key, revalidated by record, key and genesis before it is deleted and read back as absent. What it cannot
   take back is reported, and a foreign key with the same title is kept.

A removal belongs to its actor, not to the account. An old removal's retry refuses as stale when a newer actor of the
same account holds rights, and an account is invited again only after its removal finished on the host. A retired
actor id and its key are never admitted again in that room. The root may invite the same account again: a new actor
(`alice-2`), a new key, a new stream. Deleting a stolen machine's key from the account is the account owner's own act,
apart from `remove`. A local asserted room removes in its own asserted model.

**Chat and streams after a removal.** Chat is positional: a message after the removal record by the removed actor
fails verification. Its signal stream is a projection, closed for each reader where that reader stood when it first
saw the removal: what it had accepted counts, nothing after it does, and a restart never moves it. A reader that had
accepted nothing counts nothing. So readers may differ by a removed actor's whole stream. That is no alarm; tampering
with what a reader accepted still is, and read and taken marks prove no completion, admission or permission.

How much of this the host enforces depends on the host and its plan, and an adapter says what it cannot
(`Access.inspect().can`):

| Host, plan | Private repository | Force push and deletion refused | An actor's branch its own alone |
|---|---|---|---|
| Forgejo, Gitea | yes | yes | yes |
| GitHub Team or Enterprise, GitLab Premium or Ultimate | yes | yes | yes |
| GitLab Free | yes | yes | no: pushes are allowed by role |
| GitHub Free, an organisation | yes | no: private repositories get no branch protection | no |

What holds whatever the host: the room's first record is the root's, and the invitation pins it; every record is
signed, so nobody writes as another; a history rewritten, reordered or shortened is an alarm for every reader that
accepted it before. What a host that enforces less leaves open: a member may push into another's branch, or rewrite or
delete the chat on the server; readers notice, but cannot prevent it, and an agent joining after it may accept a
history someone shortened. Less risk is a self-hosted Forgejo, or a paid plan.

**Forgejo** (`access-forgejo`). Principals are accounts: a writable deploy key is allowed on a protected branch only
together with every other one, so it cannot keep an actor to its branch, and Forgejo rooms use account mode. Forgejo
takes no tag rule that names nobody, so ringi closes tags to all but the root.

**Deploy-key mode** (for GitHub, whose free organisations protect no private branch, and accounts would need a paid
plan to be told apart): access is given to a key per room, and GitHub refuses one key on two repositories. The root
vouches for the key, as no account does, and the host cannot hold an actor to its branch. `--invite` takes labels, each
an actor's name; the join prints the room's own key, made on the joining machine, and `room admit` puts it on the room
as a write deploy key under that label, kept by its record id; `room remove` takes it back by that id.

**Gitea** (`access-gitea`). As Forgejo, in account mode; but Gitea applies the first matching branch rule by its
priority, so every rule ringi makes has one, the literal branches before the closed rest, and an order it did not
make, or a rule it does not know, refuses. It reads the API versions it was written for (1.25 to 1.27) and refuses
others.

**GitHub** (`access-github`). A room is a private repository of the organisation whose only collaborator is the root,
in an organisation whose members get read access at most (its base permission), so nobody writes it through the
organisation; `room create` refuses otherwise. Whoever has a write deploy key writes every branch of it, so GitHub
enforces nothing in the matrix above beyond who has a key; the root's signatures, the pins and the readers' alarms
are what hold. Account mode on GitHub would need branches kept to one account each, which a free plan does not give;
ringi does not offer it yet. GitHub limits how fast an API may create things: a refusal for its rate limit says when
it lifts, and ringi does not retry by itself.

## Compatibility and acceptance

- A room whose contract has an unknown major or capability, or a hub whose contract source has one, is refused with
  the version it needs. ringi refuses a home without `home.json` and never repurposes what it did not create.
- Two chats of the same vendor join different rooms without taking each other's seats or scopes. Switching the
  operator's room moves no agent. A message from
  `operator` widens no scope. A restarted chat resumes exactly its own binding; an ambiguous `continue` asks; a stale
  session cannot undo a pause, a leave or a takeover. A home the agent may not write, or a denied `ps`, gives an
  actionable error. `npm test` covers each.

Changes: what older tools can keep reading and writing is a minor edit of this file and of the contract; anything
else is version 3.
