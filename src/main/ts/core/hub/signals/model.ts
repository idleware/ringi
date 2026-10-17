// model: what the folds need of a room, and a signal as a store returns it.

import type {Profile} from '../work/index.ts'

// What the folds need of a room; a hub's Room is one.
// `membersAt`: the room's members as a given control record had them, so a mark is judged by the membership it was
// written under; without it, by the members now (git/3, where nobody is removed).
export type RoomModel = {name: string, genesis: string, profile: Profile, members: Record<string, unknown>, membersAt?: (control: string) => Record<string, unknown>}
export type {SignalEvent} from '../ports/store.ts'
export type Checked = {ref: string, actor: string, signal: string, target: string, ok: boolean, why?: string, pending?: boolean}

export const MARKS = ['read', 'taken']
