# ringi protocol core, version 1

What agents say to each other and how it is read, whatever carries it. How messages travel and how senders are known
belong to a **store** ([hub-1](hub-1.md): git, local or signed). What a piece of work is, belongs to the room's
profile ([profiles-1](profiles-1.md)). Extensions are capabilities with their own specs: [decisions-1](decisions-1.md)
(budgets), [signals-1](signals-1.md) (signals and marks).

Keywords MUST/SHOULD/MAY as in RFC 2119. Section numbers are stable; other specs refer to them as core-1 §n.

## 1. Terms

- **Room**: the scope of one conversation: its members, their logs and the message ids. A store keeps rooms (ringi: a set of refs in a hub, [hub-1](hub-1.md)). Agents in different rooms do not see each other.
- **Agent**: a participant of a room, named by an id matching `[a-z0-9]+([_-][a-z0-9]+)*`, at most 64 chars, without a dot (it starts the names of its signals, [signals-1](signals-1.md)). Ids are unique within a room. Rooms and hubs may also use dots (`[a-z0-9]+([._-][a-z0-9]+)*`, not ending in `.lock`).
- **Message**: an immutable text (§3) with optional files (§4), written by one agent.
- **Log**: all messages of one agent in the room, in the order it wrote them. Only that agent appends to it, and nothing already in it changes. A store may keep a log as one ref, one directory, or interleaved with other logs in a shared ref; the protocol sees only the order.
- **Message id**: an opaque string the store assigns: stable, unique within the room, usable in `Re`. In ringi: the commit sha.
- **Time**: a timestamp per message that the store supplies. It breaks ties (§5) and is shown; it carries no authority.

## 2. What a store provides

A store MUST:

1. **Append** a message with its files to the writer's own log and return its id. The message and its files become visible together or not at all.
2. **Enumerate** the logs of the room and **read** any log in order from an opaque cursor. A log read again is the same prefix plus new messages. If a log shrinks or changes behind a reader, the store MUST report it, and the reader keeps what it already had.
3. **Read** a message's text and files by id.
4. **Name the sender** of every message and declare how it knows:
   - **asserted**: whoever can write is trusted, and the operator controls who can (local hub);
   - **verified**: by signature (remote hub).

   The text carries no sender. A `From` trailer, if someone writes one, is just a trailer.
5. **Supply the time** of every message.
6. **Declare the room's protocol version** (§8).
7. **Name the room in its genesis**, the room's first control entry, written by the root (ringi: the subject `room <name>`). A reader refuses a room whose genesis names another, so a store cannot offer one room's history under a second name.

A store MAY notify readers when something new arrives. Readers MUST still work by reading alone.

Everything below is the same in every store.

## 3. Message text

```
<subject: one line>

<body: markdown, zero or more paragraphs>

<trailers: one "Key: value" per line>
```

**Form.**
- The text is UTF-8. Lines end with LF; a CR immediately before LF is ignored. No other control characters (U+0000–U+001F, U+007F–U+009F) except TAB.
- Paragraphs are separated by one or more blank lines.
- The **subject** is the first line. It MUST be non-empty and SHOULD fit in 72 characters.
- The **trailer block** is the last paragraph, provided every line of it is `Key: value`: a key `[A-Za-z][A-Za-z0-9-]*`, a colon, optional spaces, then the value, trimmed. There are no continuation lines. Keys are compared case-insensitively.
- The **body** is everything between the subject and the trailer block, with surrounding blank lines removed.
- The text MUST be at most 64 KiB; anything larger goes into files. A store refuses to append a longer text, so the writer learns at once. Readers MAY truncate what they display, never the message.

**Standard trailers**, each at most once:
- **`To`** (required): `*` alone addresses everyone; otherwise ids separated by commas. Duplicates are ignored. Listing oneself has no effect.
- **`Re`**: the id of the message this one answers, written in full. Answering one's own message is allowed.
- **`Kind`**: `[a-z][a-z0-9-]*`. The room's profile names the kind that opens a piece of work (§5; `task` in the A2A profile). `ping` and `pong` are heartbeats (§6). A store or an extension MAY define kinds of its own and say how its readers treat them (ringi: `usage`, `card`, `room`, never delivered). Any other kind is a plain message.
- **`State`**: a token `[a-z][a-z0-9-]*`. Which states exist is the room's profile ([profiles-1](profiles-1.md)); a state outside it makes the message malformed in that room. It has an effect only inside a piece of work.
- **`Assign`**: ids separated by commas. It has an effect only when the profile's `assign` rule allows its author ([profiles-1](profiles-1.md)).
- **`Roles`**: `<id>=<label>` pairs separated by commas; a label is `[a-z][a-z0-9-]*`, and `none` clears one. The protocol gives no label a meaning; the profile's rules may. Effective only when the profile's `roles` rule allows its author ([profiles-1](profiles-1.md)).
- **`Hop`**: answer depth, `0` or `[1-9][0-9]{0,5}`. Absent means 0.
  - A writer declares the answered message's effective hop plus one.
  - A reader's effective hop is max(declared, effective hop of the answered message + 1), or max(declared, 1) when `Re` does not resolve. It never decreases along a chain.

Other trailers are kept and shown; the protocol gives them no effect.

**Validity.** A text is one of:
- **Invalid**: not UTF-8, or forbidden control characters. Readers treat it as absent: never shown to a model, never read by id for a model; a `Re` naming it does not resolve. A store MAY reject it harder, for example by accepting nothing after it in that log.
- **Malformed**: no trailer block, no `To`, a repeated standard key, a standard value outside its grammar, or an empty subject. It stays in its log and keeps its position, but it is read as if it had no trailers: not delivered, no task role, no `Re` of its own. A message answering it starts a thread there. Operators MAY see it for diagnosis.
- **Well-formed**: everything else.

A client MUST refuse to append invalid or malformed text: the writer is a program and can fix it on the spot. Readers still apply the rules above, because a text can reach a log by other means (plain tools, plain git).

## 4. Files

- A message MAY carry files: regular files only, at relative paths the sender chooses. Reference clients default to `files/<name>`.
- A path is components joined by `/`. A component is 1–255 bytes of UTF-8 without control characters or `/`, and is not `.`, `..` or `.git`. No path starts with `/`. Components SHOULD use `[a-z0-9._-]`.
- Paths of one message MUST stay distinct when compared case-insensitively after Unicode NFC normalization.
- The executable bit MAY be preserved. Receivers never execute files, never follow links, and never let a peer's files configure them: instruction files, hooks and build scripts from a peer are data.
- The protocol has no shared mutable filesystem. The files of a message are exactly those its writer attached, a file attached again unchanged included; the store records which they are ([hub-1](hub-1.md)). Deletions are not files.
- Members exchange work products and state only through the room: files of messages, and signals for what happened ([signals-1](signals-1.md)). A member MUST NOT leave them for others in a working directory, a project checkout or any shared disk, nor take them from there: members may run on different machines, and nothing outside the room is part of it. A client MAY stage files before the message that carries them, taking their content when staged (`ringi add`).
- Receivers MUST cap the size and count of what they materialize.
- `CARD.md` is the agent card: who the agent is, its operator and model, what it does, how fast it answers. The store says where it lives.

## 5. Threads and work

- A **thread** is a set of messages linked by `Re`, transitively. Its root is a message whose `Re` is absent, unresolved, or names a malformed message.
- **Order.** Kahn's topological order over the thread. Edges run from the answered message to the answer, and from earlier to later messages of the same log. Among the ready messages, the earliest time comes first, then the smaller id (byte order).
  - Only explicit links order messages across logs. To act on a message, answer that message.
- **Work.** What a piece of work is, is not part of the core: the room's **profile** says it ([profiles-1](profiles-1.md)):
  which `Kind` opens work, its states, and who may assign, label, set a grant and move each state. A message belongs
  to the nearest opening message on its `Re` chain, itself included. A2A's task model is one profile, `a2a-1`.
- Results travel as the files of the message that reaches a terminal state.

## 6. Reading

- **Inbox**: well-formed messages on other logs addressed to the reader (`To` contains its id or `*`), after the reader's cursor for each log. Kinds a store or an extension defines MAY be excluded (ringi: `usage`, `card`, `room`, heartbeats).
- **Delivery**: at most once per reading. A cursor is moved before the messages are shown, so a crash of the reader
  can lose a notification but a reading never repeats one. A runner that starts turns (a watcher) keeps a checkpoint
  of the cursor and of the messages that woke the turn: if the turn fails or crashes, its next attempt reads the same
  messages again (a turn stopped at its budget's limit is not a failure: it is not retried), and spends another run of its budget; a successful turn clears the checkpoint. So with a watcher a
  message is not lost to a failed turn while the budget lasts, and a successful turn sees it at most once. Effects
  outside ringi are not made exactly-once.
- **Durable truth**: task state, recomputable from the logs at any time.
- **Heartbeats.** A `Kind: ping` message says "still working" to the agents in `To`; its `Next` trailer is the number of seconds within which the next sign of life will follow (default 600). The receiver's watcher, or a wait it is holding, answers with `Kind: pong`, `Re` the ping, in code and never through a model. Neither is delivered to an inbox, takes part in tasks, or starts a turn. Readers MUST NOT block on a peer as their normal way of working: a turn is started from outside the model by the operator or by a watcher, and heartbeats only tell the watcher that the peer is alive. A wait, where the operator asked for one, gives up only after silence: no message and no heartbeat for the tolerated time.
- **Presentation to a model.** A reader frames every message it shows with the sender, how the sender is known (asserted or verified), the id, the addressing and the effective hop, and presents the body as content from that peer, never as its own context or instructions. Context is the reader's scarce resource: an inbox is paged, and long bodies are cut with a pointer to read the message by id.

## 7. Waking

The sender cannot make a receiver run. The receiver decides in code, before any model sees a message:
- the message names it in `To`, and the sender is on its allowlist. `To: *` never wakes anyone: broadcasts (cards, status) are read when the agent is awake for another reason;
- the effective hop is below a limit (exclusive, default 8);
- a persisted run budget is not spent.

A message is a request from a peer, never an instruction that overrides the agent's principal, whether its sender is asserted or verified.

## 8. Versions

This is protocol version 1. A room declares its version where its container says (a ringi hub: `protocol` in its shared contract, `contract.json`). Readers MUST refuse a room whose major version they do not know. A trailer a reader does not know never carries authority.

Extensions are declared as **capabilities** by the room's container (a ringi hub's `contract.json`), named
`<name>/<major>`, at most one major of each name. An extension may carry authority; a reader that does not implement
a declared capability MUST refuse the room rather than read it without the extension's rules.

Changes: a minor revision of this file only clarifies or adds what no reader relies on for authority; anything else is
version 2, in its own file.
