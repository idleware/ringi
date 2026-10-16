# Signals and marks, version 2

Explicit markers of what happens in a room, beside the messages that carry it, cheap for any tool to poll. The
messages stay the truth: a reader recomputes everything from them, and a signal only says, checkably, what a
message did. Version 2 keeps the meaning of version 1 and changes the form: instead of a tag per marker, each actor
writes its markers as records of its own stream in the room's store ([hub-2](hub-2.md)).

## Signals: what was counted

A signal marks one transition the fold counted, made by the message's author:

| Signal | Made by | Source |
|---|---|---|
| `opened`, `assigned`, `state.<s>` | the message's author | the profile fold ([profiles-1](profiles-1.md)) |

- A signal is made only for a transition the fold counted: a `State` its author had no right to makes none.
- A signal missing after a crash between a message and its signal changes nothing; its author restores it
  (`ringi agent signals --repair`).

## Marks: where attention is

Marks share the stream and carry no authority: a mark never changes a state or an assignment.

| Mark | Meaning | Possible when |
|---|---|---|
| `read` | the reader's cursor in the author's log: every message of that log up to this one that was addressed to the reader reached it (made on delivery, on the last message of each log delivered; a peek makes none; an older per-message mark reads the same) | the message is addressed to the actor, or to all, and is not the actor's own |
| `taken` | this member is on the piece of work | the message opens work under the room's profile |

## Form

A signal or mark is one record of its actor's stream, nothing else. In a git store it is a commit on
`<actor>/signals`, with one parent (the actor's previous record, or the room's genesis for the first), the parent's
tree, its actor as author and committer, and only these trailers:

- `Room`: the room's full genesis;
- `Control`: the full id of the chat's control record the actor writes under, which a reader must have accepted;
- `Target`: the full id of the message in the chat;
- `Signal`: the signal or mark.

On a signed hub it is signed by the actor with the key admitted at `Control`. The actor, target and signal identify
it: writing the same one again adds nothing, and a reader counts it once. The commit's own time says when it was
made and orders nothing: a record's place in the room is the message it names.

## Checking

A reader checks every record of every stream before it counts:

- the stream is linear, continues what the reader accepted, and its records name this room;
- `Control` is a control record the reader accepted from the chat, and on a signed hub the record's signature is the
  actor's key admitted there;
- `Target` is an accepted message of the chat, not a control record;
- a signal's target is the actor's own message, and the fold, as of that message, made exactly that signal;
- a mark is possible.

A record whose `Control` or `Target` the reader has not yet accepted waits, changing nothing, until it has. A record
that fails a check stops the stream at the last record that passed, with an alarm; a stream whose accepted records
were rewritten or deleted alarms too. Neither changes what the messages say. The reader pins the head of each stream
it accepted.

Changes: a new signal or mark is a minor edit of this file; a new record form or namespace is version 3.
