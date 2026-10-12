// sync-tags: fetched tags sorted into signals (immutable, pinned) and heartbeats (replaced).

import * as C from '../../../lib/index.ts'
import {git, object, reason, refs, zero} from './git.ts'
import {heartbeatName} from './heartbeat.ts'
import {SIGNAL_NAME, checkSignal, signalObject} from './signals.ts'
import type {Handle} from './types.ts'
import {TAGS, TAG_ACCEPT, TAG_TRACK} from './types.ts'

import {syncHeartbeat} from './sync-heartbeat.ts'
import type {RoomsIndex} from './sync-rooms.ts'
export type TagSync = RoomsIndex & {H: Handle, tags: Map<string, string>, pinned: Map<string, string>}
const missingHeartbeats = (H: Handle, tags: Map<string, string>, pinned: Map<string, string>): void => {
  // Include local beats to remove disappeared remote telemetry; unlike signals, nothing is pinned.
  for (const ref of refs(H, TAGS).keys()) if (heartbeatName(ref) && !tags.has(TAG_TRACK + ref.slice(TAGS.length))) {
    if (pinned.has(TAG_ACCEPT + ref.slice(TAGS.length))) continue // never waive previously accepted history
    git(H, ['update-ref', '-d', ref])
  }
}
const syncSignal = ({H, tags, pinned, byTarget}: TagSync, name: string): void => {
  const ref = TAGS + name
  try {
    const sha = tags.get(TAG_TRACK + name) ?? C.fail('signal was deleted on the remote after acceptance')
    const s = signalObject(H, ref, sha)
    const R = byTarget.get(s.message) ?? C.fail('signal room is missing or quarantined')
    checkSignal(H, R, ref, sha)
    const acc = pinned.get(TAG_ACCEPT + name), cur = object(H, ref)
    if (acc && acc !== sha) C.fail('signal was replaced after transport acceptance')
    if (cur && cur !== sha) C.fail('signal diverges from the local tag object')
    git(H, ['update-ref', ref, sha, cur ?? zero(H)])
    git(H, ['update-ref', TAG_ACCEPT + name, sha, acc ?? zero(H)])
  } catch (e) {H.remoteAlarms![ref] = reason(e)}
}
export const syncTags = (H: Handle, rooms: RoomsIndex): void => {
  const tags = refs(H, TAG_TRACK), pinned = refs(H, TAG_ACCEPT)
  missingHeartbeats(H, tags, pinned)
  const state: TagSync = {H, tags, pinned, ...rooms}
  const names = new Set([...tags.keys()].map(r => r.slice(TAG_TRACK.length)).concat([...pinned.keys()].map(r => r.slice(TAG_ACCEPT.length))))
  for (const name of names) {
    if (heartbeatName(TAGS + name)) syncHeartbeat(state, name)
    else if (SIGNAL_NAME.test(name)) syncSignal(state, name)
  }
}
