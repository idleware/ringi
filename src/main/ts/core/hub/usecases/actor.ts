// actor: who acts, and in which room; every operation of a participant takes one.

import type {Room} from '../rooms/index.ts'

export type Actor = {R: Room, me: string}
export const isRef = (R: Room) => (x: string): boolean => R.hub.store.isRef(x)
