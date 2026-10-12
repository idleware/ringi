// order: the order of messages (core-1 §5).

import type {Message} from './model.ts'

// The order's edges: each log in sequence, and each answer after what it answers.
const graph = (list: Message[]) => {
  const byId = new Map(list.map(m => [m.id, m]))
  const next = new Map<string, Message[]>(list.map(m => [m.id, []]))
  const indeg = new Map<string, number>(list.map(m => [m.id, 0]))
  const edge = (a: Message, b: Message) => {
    next.get(a.id)!.push(b)
    indeg.set(b.id, indeg.get(b.id)! + 1)
  }
  const last = new Map<string, Message>()
  for (const m of [...list].sort((a, b) => a.seq - b.seq)) {
    if (last.has(m.from)) edge(last.get(m.from)!, m)
    last.set(m.from, m)
    if (m.reId && byId.has(m.reId)) edge(byId.get(m.reId)!, m)
  }
  return {next, indeg}
}
const earliest = (a: Message, b: Message): number => a.time - b.time || (a.id < b.id ? -1 : 1)
// Kahn's order: the answered message before the answer, earlier before later within one log; among the ready ones,
// the smallest (time, id) goes first.
export const ordered = (list: Message[]): Message[] => {
  const {next, indeg} = graph(list)
  const ready = list.filter(m => !indeg.get(m.id))
  const res: Message[] = []
  while (ready.length) {
    const m = ready.sort(earliest).shift()!
    res.push(m)
    for (const n of next.get(m.id)!) {
      indeg.set(n.id, indeg.get(n.id)! - 1)
      if (!indeg.get(n.id)) ready.push(n)
    }
  }
  return res
}
