// reading: what is delivered to whom (core-1 §6) and what wakes it (§7).

import type {Logs, Message} from './model.ts'
import {ordered} from './order.ts'

const addressed = (m: Message, id: string): boolean => m.to.includes(id) || m.to.includes('*')
const hiddenKind = (m: Message, hidden: Set<string>): boolean => !!m.kind && hidden.has(m.kind)
// Delivered: well-formed, not a hidden kind, addressed to `id` by name or `*`.
export const visible = (m: Message, id: string, hidden: Set<string>): boolean =>
  !m.invalid && !m.bad && !hiddenKind(m, hidden) && addressed(m, id)
// Wakes: only a direct address. Broadcasts are read when the agent is awake for another reason.
export const wakes = (m: Message, id: string, hidden: Set<string>): boolean => visible(m, id, hidden) && m.to.includes(id)

const after = (msgs: Message[], cursor: string | undefined): Message[] => msgs.slice(msgs.findIndex(m => m.id === cursor) + 1)
const others = (logs: Logs, id: string) => [...logs].filter(([log]) => log !== id)
// Each log's cursor moves past what was shown and what is not for `id`, up to the first message held back.
const advance = (logs: Logs, id: string, cursors: Record<string, string>, seen: Set<string>, hidden: Set<string>): Record<string, string> => {
  const next = {...cursors}
  for (const [log, msgs] of others(logs, id)) {
    for (const m of after(msgs, cursors[log])) {
      if (visible(m, id, hidden) && !seen.has(m.id)) break
      next[log] = m.id
    }
  }
  return next
}
// Messages for `id` after the per-log cursors; cursors advance only past what was shown.
export const unread = (logs: Logs, id: string, cursors: Record<string, string>, limit = Infinity, hidden: Set<string>) => {
  const queue = ordered(others(logs, id).flatMap(([log, msgs]) => after(msgs, cursors[log]).filter(m => visible(m, id, hidden))))
  const shown = queue.slice(0, limit)
  return {msgs: shown, rest: queue.length - shown.length, cursors: advance(logs, id, cursors, new Set(shown.map(m => m.id)), hidden)}
}
