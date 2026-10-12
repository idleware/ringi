// pins: a reader's pins, the stored object of each signal it accepted. A changed or vanished one is an alarm.

import type {Checked, SignalRecord} from './model.ts'

// A signal's identity in any store and after an archive: its tag's name `<actor>.<signal>.<message12>`.
const keyOf = (ref: string): string => ref.split('/').at(-1)!
export const pins = (records: SignalRecord[], checked: Checked[], accepted: Record<string, string> = {}): {accepted: Record<string, string>, alarms: string[]} => {
  const now = new Map(records.map(x => [`${x.actor}.${x.name}`, x]))
  const alarms: string[] = []
  const next: Record<string, string> = {}
  for (const [k, object] of Object.entries(accepted)) {
    const key = keyOf(k), x = now.get(key)
    next[key] = object
    if (!x) alarms.push(`signal ${key} was removed after it was accepted`)
    else if (x.object !== object) alarms.push(`signal ${x.ref} was replaced after it was accepted`)
  }
  for (const c of checked) if (c.ok && !next[keyOf(c.ref)]) next[keyOf(c.ref)] = now.get(keyOf(c.ref))!.object
  return {accepted: next, alarms}
}
