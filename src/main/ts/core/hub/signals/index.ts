// signals: explicit markers of what happens in a room, beside the messages that carry it (signals-2). Every effective
// transition (work opened, assigned, a state reached) is also a signal of its author: a record of the author's own
// stream naming the room, the control it writes under, the message and the signal; in a git store a commit on
// `<author>/signals`, signed on a signed hub. The author, message and signal identify it, so writing it again adds
// nothing. Signals are visible with the store's own tools (`git log`, a forge's branches and push webhooks) and cheap
// to poll.
//
// The messages stay the truth. A signal is made only for a transition the fold actually counted (a State the author
// had no right to makes none). A reader checks every signal against its message and pins each stream's accepted
// prefix; a signal that disagrees, or an accepted stream that changes or disappears, is an alarm. A signal missing
// after a crash between message and signal changes nothing and is restored with `signals --repair`.
//
// Marks are the second layer, in the same stream: where attention is, not what was decided. `read` is its reader's
// cursor in one author's log: every message of that log up to it that was addressed to the reader reached it (made on
// delivery, one per log); `taken` says a member took a piece of work. A mark changes no state
// or assignment. It is checked only for being possible: its target is an accepted message of the room, its
// actor a member; `read` only for a message addressed to the actor or to all, `taken` only for a message that opens
// work.

export * from './model.ts'
export * from './marks.ts'
export * from './effective.ts'
export * from './check.ts'
export * from './pins.ts'
