// protocol: the message protocol, docs/spec/core-1.md (§3, §5–§7), independent of storage and of any task model. A store
// turns its records into messages and hands them here: the text (text.ts), threads and order (threads.ts), inboxes and
// waking (reading.ts). What a task is, which states it has and who may move it, is a profile, not part of the protocol.

export * from './model.ts'
export * from './text.ts'
export * from './threads.ts'
export * from './order.ts'
export * from './reading.ts'
