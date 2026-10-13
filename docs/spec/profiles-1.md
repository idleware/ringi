# Profiles, capability `profiles/1`

What a piece of work is, and who may move it, is data: a **profile**. ringi knows no state, role or rule by name; it
folds whatever profile the room carries. The A2A task model is one profile among others.

## Where a profile lives

- A hub carries profiles in its shared contract: `profiles/<name>.json` on `main` ([hub-2](hub-2.md)). The contract's
  `profile` names the default for new rooms; unset, it is `a2a-1`, which every ringi build knows.
- A room copies the text of its profile into its genesis control entry (`profile.json`) when it is made, and reads
  it only from there. Later changes to the hub's profiles never reinterpret an existing room.
- A hub whose rooms may follow a profile other than `a2a-1` declares the capability `profiles/1`, so a client that
  knows only the A2A rules refuses the hub instead of misreading it.

## Schema `ringi-profile/1`

| Field | Meaning |
|---|---|
| `schema` | `ringi-profile/1`; anything else is refused |
| `name` | an id (`team-flow-1`); a new meaning is a new name |
| `description` | optional, for people |
| `opens` | the `Kind` that opens a piece of work (core-1 §3) |
| `states` | distinct tokens `[a-z][a-z0-9-]*` |
| `initial` | the state work starts in; one of `states` |
| `terminal` | the states that end work; a subset of `states` |
| `waiting` | optional: the state of work that cannot go on without input; not terminal |
| `rules` | who may do what: `assign`, `roles`, and `state:<s>` or `state:*` for reaching a state |

A rule lists **principals**: `requester` (who opened the work), `assignee`, `member` (anyone in the room),
`role:<label>` (whoever holds that label in this work), `agent:<id>`. An empty or missing rule allows nobody. An exact
`state:<s>` rule replaces `state:*` for that state. A profile with duplicate JSON keys, an unknown rule, a state rule
for an unknown state, principals outside this grammar, or a `waiting` state that is terminal is refused before it
reaches a hub. Fields this schema does not name carry no meaning.

## The fold

- A message belongs to the nearest message of kind `opens` on its `Re` chain, itself included.
- Opening sets `initial`. The assignees are the opener's `Assign`, else `To` minus the opener (none for `To: *`).
- Then, in thread order (core-1 §5), each message is judged on the work as it was **before** that message: a label
  given in a message authorizes nothing in that message, and its holder may still hand it over and reassign in one
  reply. `State`, `Assign` and `Roles` take effect only where the matching rule allows the author.
- The first terminal state is final; assignment and labels may still change after it.
- A `State` outside the profile makes the message malformed in that room (core-1 §3).
- What each message actually changed (opened, assigned, roles, `state.<s>`) is its **effect**; signals are
  made only from effects ([signals-2](signals-2.md)).

## `a2a-1`, the built-in profile

```json
{"schema": "ringi-profile/1", "name": "a2a-1", "opens": "task",
 "states": ["submitted", "working", "input-required", "completed", "failed", "canceled", "rejected"],
 "initial": "submitted", "terminal": ["completed", "failed", "canceled", "rejected"], "waiting": "input-required",
 "rules": {"assign": ["requester", "role:lead"], "roles": ["requester", "role:lead"],
           "state:canceled": ["requester"], "state:*": ["assignee"]}}
```

The A2A states; the requester or a `lead` assigns and labels; the requester cancels; an assignee sets
the rest.

## Another: a review flow

```json
{"schema": "ringi-profile/1", "name": "review-1", "opens": "change",
 "states": ["draft", "in-review", "approved", "changes", "shipped", "dropped"], "initial": "draft",
 "terminal": ["shipped", "dropped"], "waiting": "changes",
 "rules": {"assign": ["requester", "role:architect"], "roles": ["requester"],
           "state:approved": ["role:reviewer"], "state:changes": ["role:reviewer"],
           "state:dropped": ["requester", "agent:hermes"], "state:*": ["assignee"]}}
```

A label such as `reviewer` means only what these rules say.

Changes: a new field or rule that older readers could ignore without granting more is a minor edit of this file;
anything else is `ringi-profile/2` and `profiles/2`, in their own file.
