// retire: a removed actor's signals as one reader sees them (git/4). Chat stays the truth and is positional; a stream
// is a projection, so when this reader first learns that an actor was removed, that actor's stream closes at what this
// reader had accepted by then, possibly nothing. Nothing beyond it counts, pins or alarms; a later look never moves
// it. Readers may thus differ by a whole stream; tampering with what was accepted stays an alarm (history/index.ts).

import type {Rev, SignalEvent} from '../ports/store.ts'

// Per retired actor: the control record that removed it, and this reader's accepted head when it learned of it.
export type Frontier = Record<string, {control: Rev, head: Rev | null}>

// The frontier with every newly retired actor closed at this reader's accepted head; one already closed stays as it was.
export const closeFrontiers = (retired: Record<string, Rev>, accepted: Record<string, Rev> = {}, frontier: Frontier = {}): Frontier => {
  const next = {...frontier}
  for (const [actor, control] of Object.entries(retired)) next[actor] ??= {control, head: accepted[actor] ?? null}
  return next
}
// The records this reader may count: a retired actor's own up to its frontier head and none after it; nothing of an
// actor whose head is not in its stream any more (the rewrite is an alarm of its own).
export const eligible = (records: SignalEvent[], frontier: Frontier = {}): SignalEvent[] => {
  const present = new Set(records.filter(x => frontier[x.actor]?.head === x.id).map(x => x.actor)), done = new Set<string>()
  return records.filter(x => {
    const f = frontier[x.actor]
    if (!f) return true
    if (f.head === null || !present.has(x.actor) || done.has(x.actor)) return false
    if (x.id === f.head) done.add(x.actor)
    return true
  })
}
