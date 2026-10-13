// push-validate: a ref checked before it is published: main, a room's branch, or an actor's signal on a message of a
// verified room.

import * as C from '../../../lib/index.ts'
import {branchData} from './branch.ts'
import {verifyMain} from './main.ts'
import {streamRoom, validateStream} from './streams.ts'
import type {Handle} from './types.ts'

export const validateRef = (H: Handle, ref: string, sha: string): void => {
  if (ref === 'refs/heads/main') {verifyMain(H, sha); return }
  const e = H.endpoint ?? C.fail('publication requires an explicit room endpoint')
  if (ref !== 'refs/heads/chat') return validateStream(H, streamRoom(H), ref, sha)
  const why = branchData(H, e.name, sha, e.genesis).skipped.get(sha)
  if (why) C.fail(`${sha.slice(0, 12)} is no valid commit of room ${e.name}: ${why}`)
}
