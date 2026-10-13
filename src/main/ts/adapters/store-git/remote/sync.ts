// sync: one fetch of a signed hub under its transport lock: contract, rooms, signals and heartbeats verified.

import * as C from '../../../lib/index.ts'
import {pushAlarms} from './alarms.ts'
import {git, isRemote, locked, origin, promote, reason, refs, rev, suffix} from './git.ts'
import {checkUrl} from './keys.ts'
import {verifyHub, verifyMain} from './main.ts'
import {syncRooms} from './sync-rooms.ts'
import {syncTags} from './sync-tags.ts'
import type {Handle} from './types.ts'
import {TAGS, TAG_TRACK, TRACK} from './types.ts'

const syncUnlocked = (H: Handle): Handle => {
  H.remoteAlarms = {...pushAlarms(H)}
  H.heartbeatErrors = {}
  const url = origin(H)
  if (!url) {if (rev(H, 'refs/heads/main')) verifyHub(H); return H}
  checkUrl(url)
  git(H, ['-c', 'fetch.fsckObjects=true', 'fetch', '-q', '--no-tags', '--prune', url,
    `+refs/heads/*:${TRACK}*`, `+${TAGS}*:${TAG_TRACK}*`])
  const fetched = refs(H, TRACK)
  const main = fetched.get(TRACK + 'main') || C.fail('ALARM remote main was deleted or is missing; refusing authority from the hub')
  try {verifyMain(H, main); promote(H, 'refs/heads/main', main)} catch (e) {C.fail(`ALARM hub ${H.name}: ${reason(e)}; nothing is delivered`)}
  H.main = rev(H, 'refs/heads/main')!
  syncTags(H, syncRooms(H, fetched))
  for (const [ref, why] of Object.entries(H.remoteAlarms)) C.note(`ALARM ${suffix(ref)}: ${why}; quarantined and withheld`)
  return H
}

export const sync = (H: Handle): Handle => !isRemote(H) ? H : locked(H, () => syncUnlocked(H))
