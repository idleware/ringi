# Signals and marks, version 1

Explicit markers of what happens in a room, beside the messages that carry it, cheap for any tool to poll. The
messages stay the truth: a reader recomputes everything from them, and a signal only says, checkably, what a
message did.

## Signals: what was counted

A signal marks one transition the fold counted, in its author's namespace, named after the full message id:

| Signal | Made by | Source |
|---|---|---|
| `opened`, `assigned`, `state.<s>` | the message's author | the profile fold ([profiles-1](profiles-1.md)) |
| `proposed`, `stamp.<x>`, `decision.<d>` | the author; a stamp only from a named reviewer, a decision only the one that counts | [decisions-1](decisions-1.md) |
| `usage.reserve`, `usage.settle` | the runner | a receipt the grant's ledger counts ([decisions-1](decisions-1.md)) |

- A signal is made only for a transition the fold counted: a `State` its author had no right to makes none.
- A signal missing after a crash between a message and its signal changes nothing; its author restores it
  (`ringi agent signals --repair`).

## Marks: where attention is

Marks share the namespace (`<message>.<mark>` under the actor) and carry no authority: a mark never changes a state,
an assignment or a budget.

| Mark | Meaning | Possible when |
|---|---|---|
| `read` | the message reached this reader (made on delivery; a peek makes none) | the message is addressed to the actor, or to all, and is not the actor's own |
| `taken` | this member is on the piece of work | the message opens work under the room's profile |

## Form

A signal or mark is its name, its target and its actor, nothing else. In a git store it is an annotated tag
`<actor>.<signal>.<message12>` on the message's commit (`message12`: the first 12 hex digits of its id), tagged by the
actor, with no text, signed by the actor on a signed hub ([hub-1](hub-1.md)). The message's id makes the name unique,
so writing a signal twice is a no-op; the tag's own time says when it was made. Its room is the room whose branch
holds its message; archiving a room leaves its signals where they are. Agent ids have no dot (core-1 §1), so a name
reads unambiguously: the actor up to the first dot, the message after the last, the signal between.

## Checking

A reader checks every signal and mark: the tagger is the actor; the name's message is a prefix of the target; a
signal's message is the actor's own and made exactly that signal; a mark is possible; the tag has no text (a signed
one only its signature). The reader pins the stored object of each it accepted. A signal that fails a
check, or an accepted one that is replaced or deleted, is an alarm; it never changes what the messages say.

On a signed hub the transport also requires the actor's admitted signature and, for a signal, a target in the
actor's own valid message in the room's branch; for a mark, any valid message of the room.

Changes: a new signal or mark is a minor edit of this file; a new body or namespace is version 2.
