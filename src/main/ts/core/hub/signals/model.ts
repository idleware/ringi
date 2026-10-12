// model: what the folds need of a room, and a signal as a store returns it.

import type {AuthorityAt} from '../decisions/index.ts'
import type {Profile} from '../work/index.ts'

// What the folds need of a room; a hub's Room is one.
export type RoomModel = {name: string, genesis: string, profile: Profile, members: Record<string, unknown>, authorityAt: AuthorityAt}
// A stored signal as a store returns it: an annotated tag (git) or its equivalent. `name` is `<signal>.<message12>`,
// after its actor; `text` is whatever the tag says besides its signature, which for a signal is nothing.
export type SignalRecord = {ref: string, object: string, name: string, actor: string, target: string, tagger: string, text: string}
export type Checked = {ref: string, actor: string, signal: string, target: string, ok: boolean, why?: string}

export const MARKS = ['read', 'taken']
// A signal's name after its actor: the signal and the message's short id.
export const signalName = (id: string, signal: string): string => `${signal}.${id.slice(0, 12)}`
