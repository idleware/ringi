// Each actor pin is a verified stream prefix. A failed/pending record cannot be skipped when advancing it.
import type {Checked, SignalEvent} from './model.ts'
const grouped = (records: SignalEvent[]): Map<string, SignalEvent[]> => {
  const streams = new Map<string, SignalEvent[]>()
  for (const x of records) {const stream = streams.get(x.actor) ?? []; stream.push(x); streams.set(x.actor, stream)}
  return streams
}
const suffix = (stream: SignalEvent[], pin?: string): SignalEvent[] | null => {
  if (!pin) return stream
  const at = stream.findIndex(x => x.id === pin)
  return at === -1 ? null : stream.slice(at + 1)
}
const advance = (stream: SignalEvent[], verdict: Map<string, Checked>, parent: string): {head: string, alarm?: string} => {
  for (const x of stream) {
    if (x.parent !== parent) return {head: parent, alarm: `signal stream ${x.actor} is not a continuation of ${parent}`}
    const c = verdict.get(x.id)
    if (!c || (!c.ok && c.why)) break
    // Duplicate valid tuples extend the prefix, though they count only once in the fold.
    parent = x.id
  }
  return {head: parent}
}
const acceptActor = (actor: string, stream: SignalEvent[], verdict: Map<string, Checked>, pin?: string) => {
  const tail = suffix(stream, pin)
  if (!tail) return {head: pin!, alarm: `signal stream ${actor} does not include its accepted prefix ${pin}`}
  return advance(tail, verdict, pin ?? stream[0].roomGenesis)
}
export const pins = (records: SignalEvent[], checked: Checked[], accepted: Record<string, string> = {}): {accepted: Record<string, string>, alarms: string[]} => {
  const next = {...accepted}, alarms: string[] = [], streams = grouped(records)
  const verdict = new Map(checked.map(c => [c.ref, c]))
  for (const actor of Object.keys(accepted)) if (!streams.has(actor)) alarms.push(`signal stream ${actor} was removed after it was accepted`)
  for (const [actor, stream] of streams) {
    const result = acceptActor(actor, stream, verdict, accepted[actor])
    if (result.head !== stream[0].roomGenesis) next[actor] = result.head
    if (result.alarm) alarms.push(result.alarm)
  }
  return {accepted: next, alarms}
}
