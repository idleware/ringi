// pins: a reader's pins, the stored object of each signal it accepted. A changed or vanished one is an alarm.

import type {Checked, SignalRecord} from './model.ts'

// A signal's identity in any store and after an archive: its tag's name `<actor>.<signal>.<message12>`. Pins an older
// reader kept as `<actor>/<message>.<signal>`, or under a full ref ending so, read the same way.
const keyOf = (ref: string): string => {
  const parts = ref.split('/'), last = parts.at(-1)!
  const old = /^([0-9a-f]{40,64})\.(.+)$/.exec(last)
  return old && parts.length >= 2 ? `${parts.at(-2)}.${old[2]}.${old[1].slice(0, 12)}` : last
}
export const pins = (records: SignalRecord[], checked: Checked[], accepted: Record<string, string> = {}): {accepted: Record<string, string>, alarms: string[]} => {
  const now = new Map(records.map(x => [`${x.actor}.${x.name}`, x]))
  const alarms: string[] = []
  const next: Record<string, string> = {}
  for (const [k, object] of Object.entries(accepted)) {
    const key = keyOf(k), x = now.get(key)
    // Two old pins of one signal (its live and its archived ref) that disagree: keep the first as accepted and the
    // other under its own ref as evidence, so the conflict is reported on every read until it is resolved.
    if (key in next && next[key] !== object) {
      alarms.push(`signal ${key} has two different accepted objects (${next[key]} and ${object})`)
      next[k] = object
      continue
    }
    next[key] = object
    if (!x) alarms.push(`signal ${key} was removed after it was accepted`)
    else if (x.object !== object) alarms.push(`signal ${x.ref} was replaced after it was accepted`)
  }
  for (const c of checked) if (c.ok && !next[keyOf(c.ref)]) next[keyOf(c.ref)] = now.get(keyOf(c.ref))!.object
  return {accepted: next, alarms}
}
