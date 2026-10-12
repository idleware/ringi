// push-validate: a ref checked before it is published: a room's branch or a signal of its own message.

import * as C from '../../../lib/index.ts'
import * as P from '../../../core/hub/protocol/index.ts'
import {branchData} from './branch.ts'
import {ancestor, refs} from './git.ts'
import {verifyMain} from './main.ts'
import {checkSignal, signalObject} from './signals.ts'
import type {Handle} from './types.ts'
import {TAGS} from './types.ts'

export const validateRef = (H: Handle, ref: string, sha: string): void => {
  if (ref.startsWith(TAGS)) {
    return validateSignalRef(H, ref, sha)
  }
  if (ref === 'refs/heads/main') {verifyMain(H, sha); return }
  const room = /^refs\/heads\/([^/]+)$/.exec(ref) ?? C.fail('only explicit main, room or signal refs may be pushed')
  if (!P.ID_RE.test(room[1])) C.fail('only explicit main, room or signal refs may be pushed')
  const why = branchData(H, room[1], sha).skipped.get(sha)
  if (why) C.fail(`${sha.slice(0, 12)} is no valid commit of room ${room[1]}: ${why}`)
}

const validateSignalRef = (H: Handle, ref: string, sha: string): void => {
  const s = signalObject(H, ref, sha)
  for (const [branchRef, head] of refs(H, 'refs/heads/')) {
    const name = branchRef.slice('refs/heads/'.length)
    if (name === 'main' || name.includes('/') || !ancestor(H, s.message, head)) continue
    const b = branchData(H, name, head)
    if (b.control.includes(s.message) || b.authors.has(s.message) || b.skipped.has(s.message)) {checkSignal(H, {name, ref: branchRef, head: b.control.at(-1)!, genesis: b.genesis}, ref, sha); return }
  }
  return C.fail('signal points at no verified room')
}
