// branch: a room's branch as verified up to a tip, kept per tip; its roster, and why a log's head is not valid.

import * as C from '../../../lib/index.ts'
import {scanBranch} from './branch-scan.ts'
import {memo} from './cache.ts'
import {isRemote, reason} from './git.ts'
import type {Branch, Handle, Room, VerifiedRoom} from './types.ts'

// Memoize by immutable tip; ref names and expected genesis are checked outside the cache.
export const branchData = (H: Handle, name: string, tip: string, expectedGenesis?: string): Branch => {
  const data = memo(H, `branch/${tip}`, () => scanBranch(H, name, tip))
  if (data.subject !== `room ${name}`) C.fail(`room genesis subject must be "room ${name}"`)
  if (expectedGenesis && data.genesis !== expectedGenesis) C.fail('room changed its genesis')
  return data
}

// The room's branch verified up to `tip`; a quarantined room is not read.
export const branch = (H: Handle, R: Pick<Room, 'name' | 'ref' | 'genesis'>, tip: string): Branch => {
  if (!isRemote(H) && H.layout !== 'git/4') C.fail('room verification requires signed trust or explicit git/4')
  if (H.remoteAlarms?.[R.ref]) C.fail(`ALARM ${H.remoteAlarms[R.ref]}; room is quarantined`)
  return branchData(H, R.name, tip, R.genesis)
}

// The roster in effect at the room's latest control record.
export const verifyRoom = (H: Handle, R: Room): VerifiedRoom => branch(H, R, R.head)

// Why `head` is not a valid message of `who`, or null.
export const verify = (H: Handle, R: Room, who: string, head: string): string | null => {
  if (!isRemote(H) && H.layout !== 'git/4') return null
  try {
    const b = branch(H, R, head)
    return b.authors.get(head) === who ? null : b.skipped.get(head) ?? `${head.slice(0, 12)} is not a message of ${who}`
  } catch (e) {return reason(e)}
}
