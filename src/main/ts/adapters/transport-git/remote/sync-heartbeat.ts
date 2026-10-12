import * as C from '../../../lib/index.ts'
import {git, reason} from './git.ts'
import {checkHeartbeat, heartbeatObject} from './heartbeat.ts'
import {TAGS, TAG_ACCEPT, TAG_TRACK} from './types.ts'

import type {TagSync} from './sync-tags.ts'
export const syncHeartbeat = ({H, tags, pinned, byGenesis}: TagSync, name: string): void => {
  const beatRef = TAGS + name
  if (pinned.has(TAG_ACCEPT + name)) {
    H.remoteAlarms![beatRef] = 'heartbeat namespace overlaps a previously accepted signal; operator review required'
    return
  }
  try {
    const sha = tags.get(TAG_TRACK + name) ?? C.fail('heartbeat is absent from the remote')
    const b = heartbeatObject(H, beatRef, sha)
    const R = byGenesis.get(b.genesis) ?? C.fail('heartbeat room is missing or quarantined')
    checkHeartbeat(H, R, beatRef, sha)
    git(H, ['update-ref', beatRef, sha])
  } catch (e) {
    H.heartbeatErrors![beatRef] = reason(e)
    git(H, ['update-ref', '-d', beatRef])
    C.note(`heartbeat ${name}: ${reason(e)}; withheld`)
  }
}
