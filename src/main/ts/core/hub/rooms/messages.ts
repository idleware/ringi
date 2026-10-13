// messages: stored records read as messages, and a message written with the signals it made.

import {decodeText, link, parse} from '../protocol/index.ts'
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
  const p: Parsed = parse(d.text!, s => R.store.isRef(s))
  // The room profile's states are part of a message's validity.
  const state = p.state && !p.bad && !R.profile.states.includes(p.state) ? `State ${p.state} is not in profile ${R.profile.name}` : null
  return {...base, invalid: null, ...p, bad: p.bad ?? state}
}
// The room as stored, read without a reader's lock or state: for an author working out the signals of its own message
// (append runs inside reader locks too). Readers check signals themselves.
const asStored = (R: Room): All => {
  const s = R.store.room(R.name) ?? R.s
  return link(new Map(R.store.logIds(s).map(id => [id, R.store.messages(s, id, R.store.logHead(s, id)!).map((x, seq) => toMessage(R, id, x, seq))])))
}
// Whether a message can make signals: it opens, assigns or moves work.
const CARRIES = (p: Parsed, R: Room): boolean => !p.bad && (p.kind === R.profile.opens || !!p.assign || !!p.state)
// A message on the author's log, and the signals it made (core/hub/signals/write.ts).
export const append = (R: Room, who: string, text: string, entries: Entry[] = []): Rev => {
  const id = R.store.append(R.s, who, text, entries)
  if (CARRIES(parse(text, s => R.store.isRef(s)), R)) {
    const all = asStored(R)
    const m = all.get(id)
    if (m) emit(R, who, all, m)
  }
  return id
}
export const withSizes = (R: Room, m: Message): FileRef[] => {
  if (!m.files.length) return []
  const sizes = R.store.sizes(m.id, m.files.map(f => f.path))
  return m.files.map(f => ({...f, size: sizes.get(f.path) ?? null}))
}
