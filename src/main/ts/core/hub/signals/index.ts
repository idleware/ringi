// signals: explicit markers of what happens in a room, beside the messages that carry it. Every effective transition
// (work opened, assigned, a state reached, a proposal, a counted stamp, the decision, a counted usage receipt) is also
// a signal of its author on the message that made it: in a git store an annotated tag `<author>.<signal>.<message12>`
// on that message's commit, with no text of its own, signed on a signed hub. The message's id keeps the name unique;
// the name, target, author and time are the tag itself. Signals are visible and checkable with the store's own tools
// (`git tag -v`, a forge's tag list and tag-push webhooks) and cheap to poll.
//
// The messages stay the truth. A signal is made only for a transition the fold actually counted (a State the author
// had no right to makes none). A reader checks every signal against its message and pins the stored object it
// accepted; a signal that disagrees, or an accepted one that changes or disappears, is an alarm. A signal missing
// after a crash between message and tag changes nothing and is restored with `signals --repair`.
//
// Marks are the second layer, in the same namespace: where attention is, not what was decided. `read` says a message
// reached its reader (made on delivery); `taken` says a member took a piece of work. A mark changes no state,
// assignment or budget. It is checked only for being possible: its target is an accepted message of the room, its
// actor a member; `read` only for a message addressed to the actor or to all, `taken` only for a message that opens
// work.

export * from './model.ts'
export * from './marks.ts'
export * from './effective.ts'
export * from './check.ts'
export * from './pins.ts'
