// messages: stored records read as messages, and a message written with the signals it made.

import * as D from '../decisions/index.ts'
import {compose, decodeText, link, parse} from '../protocol/index.ts'
import type {All, FileRef, Message, Parsed} from '../protocol/index.ts'
import type {Entry} from '../protocol/files.ts'
import type {Rev, StoredMessage} from '../ports/store.ts'
import type {Room} from './index.ts'
import {emit} from '../signals/write.ts'

export const toMessage = (R: Room, from: string, x: StoredMessage, seq: number): Message => {
  const trust = R.hub.signed ? 'verified' : 'asserted'
  const files: FileRef[] = x.files.map(f => ({path: f.path, size: null}))
  const base = {id: x.id, from, trust, time: x.time, seq, files, refused: x.refused, reId: null, hopEff: 0} as const
  const d = decodeText(x.text)
  if (d.invalid !== undefined) {
    return {...base, invalid: d.invalid, subject: '', body: '', to: [], re: null, kind: null, state: null, assign: null, roles: null, hop: 0, bad: d.invalid, trailers: {}}
  }
  const p: Parsed = parse(d.text!, s => R.hub.store.isRef(s))
  // An extension's trailers and the room profile's states are part of a message's validity.
  const ext = D.check(p, s => R.hub.store.isRef(s))
  const state = p.state && !p.bad && !R.profile.states.includes(p.state) ? `State ${p.state} is not in profile ${R.profile.name}` : null
  return {...base, invalid: null, ...p, bad: p.bad ?? ext ?? state}
}
// The room as stored, read without a reader's lock or state: for an author working out the signals of its own message
// (append runs inside reader locks too). Readers check signals themselves.
const asStored = (R: Room): All => {
  const s = R.hub.store.room(R.name) ?? R.s
  return link(new Map(R.hub.store.logIds(s).map(id => [id, R.hub.store.messages(s, id, R.hub.store.logHead(s, id)!).map((x, seq) => toMessage(R, id, x, seq))])))
}
// Whether a message can make signals: it opens, assigns or moves work, or it is a record of the decisions extension.
const DECISION_KINDS = ['proposal', 'stamp', 'decision', 'usage']
const movesWork = (p: Parsed, R: Room): boolean => p.kind === R.profile.opens || !!p.assign || !!p.state
const CARRIES = (p: Parsed, R: Room): boolean => !p.bad && (movesWork(p, R) || DECISION_KINDS.includes(p.kind ?? ''))
// A message on the author's log, and the signals it made (core/hub/signals/write.ts).
export const append = (R: Room, who: string, text: string, entries: Entry[] = []): Rev => {
  const id = R.hub.store.append(R.s, who, text, entries)
  if (CARRIES(parse(text, s => R.hub.store.isRef(s)), R)) {
    const all = asStored(R)
    const m = all.get(id)
    if (m) emit(R, who, all, m)
  }
  return id
}
export const withSizes = (R: Room, m: Message): FileRef[] => {
  if (!m.files.length) return []
  const sizes = R.hub.store.sizes(m.id, m.files.map(f => f.path))
  return m.files.map(f => ({...f, size: sizes.get(f.path) ?? null}))
}
export const pongText = (me: string, m: Message, what: string): string => compose(`pong: ${me} ${what}`, [['To', m.from], ['Re', m.id], ['Kind', 'pong'], ['Hop', String(m.hopEff + 1)]])
