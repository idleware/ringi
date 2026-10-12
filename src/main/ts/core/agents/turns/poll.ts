import {locked} from '../../hub/ports/index.ts'
import type {Room} from '../../hub/rooms/index.ts'
import {openHub, openRoom, start} from '../../hub/rooms/index.ts'
import {stamp} from '../../../lib/index.ts'
import {dropSession, readSession, saveSession} from '../sessions/index.ts'
import type {WatchContext} from './types.ts'

type Poll = {done: boolean, R?: Room}
const refreshSeat = (c: WatchContext) => locked('sessions', () => {
  const cur = readSession(c.handle)
  if (cur?.state === 'active') saveSession({...cur, lastSeen: stamp(), pid: process.pid})
  return cur
})
const currentRoom = (c: WatchContext): Room | null => {
  const H = openHub(c.H0.name, {refresh: true}), R = openRoom(H, c.R0.name, {quiet: true})
  if (!R || R.genesis !== c.R0.genesis) {
    locked('sessions', () => {if (readSession(c.handle)?.genesis === c.R0.genesis) dropSession(c.handle)})
    c.log(`watch: ${c.R0.name} is gone, recreated or archived; ${c.me} left it`)
    return null
  }
  if (!R.members[c.me]) {c.log(`watch: ${c.me} was removed from ${c.R0.name}; stopping`); return null}
  return R
}
const quorum = (c: WatchContext, R: Room): Poll => {
  const st = start(R)
  if (st.started) return {done: false, R}
  if (c.w.once) c.log(`watch: ${c.R0.name} waits for a quorum of ${st.quorum} agents and has ${st.agents}; nothing to do yet`)
  return {done: !!c.w.once}
}
export const pollWatcher = (c: WatchContext): Poll => {
  const s = refreshSeat(c)
  if (!s) {c.log(`watch: the seat of ${c.me} was released or taken over; stopping`); return {done: true}}
  if (s.state === 'stopped') {
    if (c.w.once) c.log('watch: stopped by the operator')
    return {done: !!c.w.once}
  }
  const R = currentRoom(c)
  return R ? quorum(c, R) : {done: true}
}
