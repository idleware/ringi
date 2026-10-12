// check: a signal holds when its author made it, it is named after and points at a message of its author in this room,
// and that message made exactly this signal; a mark holds when it is possible.

import type {All, Message} from '../protocol/index.ts'
import {effective} from './effective.ts'
import {markWhy} from './marks.ts'
import {MARKS} from './model.ts'
import type {Checked, RoomModel, SignalRecord} from './model.ts'

const namedAfter = (id: string, target: string): boolean => id.length === 12 && target.startsWith(id)
const signalWhy = (R: RoomModel, all: All, actor: string, m: Message, signal: string): string | undefined => {
  if (m.from !== actor) return `points at a message of ${m.from}`
  return effective(R, all, m).includes(signal) ? undefined : `its message did not make ${signal}`
}
const whyNot = (R: RoomModel, all: All, x: SignalRecord, id: string, signal: string): string | undefined => {
  const m = all.get(x.target)
  const shape: Array<[boolean, string]> = [
    [!x.target, 'is not an annotated tag on a message'],
    [x.tagger !== x.actor, `was made by ${x.tagger}, not ${x.actor}`],
    [!namedAfter(id, x.target), 'is named after another message'],
    [!m, 'points at no accepted message of this room'],
  ]
  const wrong = shape.find(([bad]) => bad)
  if (wrong) return wrong[1]
  const meaning = MARKS.includes(signal) ? markWhy(R, x.actor, m!, signal) : signalWhy(R, all, x.actor, m!, signal)
  // A signal is its name and its target; any text besides a signature is not one.
  return meaning ?? (x.text === '' ? undefined : 'carries text; a signal has none')
}
export const check = (R: RoomModel, all: All, records: SignalRecord[]): Checked[] => records.map(x => {
  const dot = x.name.lastIndexOf('.')
  const signal = x.name.slice(0, dot)
  const why = whyNot(R, all, x, x.name.slice(dot + 1), signal)
  return {ref: x.ref, actor: x.actor, signal, target: x.target, ok: !why, why}
})
