// heartbeat: a signed heartbeat made and verified; it is published by heartbeat-push.ts.

import * as C from '../../../lib/index.ts'
import {git, isRemote, reason} from './git.ts'
import {heartbeatBody} from './heartbeat-facts.ts'
import {heartbeatRef} from './heartbeat-name.ts'
import {checkHeartbeat} from './heartbeat-object.ts'
import {signBytes} from '../signing.ts'
import type {Handle, Room} from './types.ts'
import {SHA, TAGS} from './types.ts'
export {checkHeartbeat, heartbeatObject} from './heartbeat-object.ts'

export {heartbeatBody} from './heartbeat-facts.ts'

export {HEARTBEAT_NAME, heartbeatName, heartbeatRef} from './heartbeat-name.ts'

export const verifyHeartbeat = (H: Handle, R: Room, ref: string, sha: string): string | null => {
  if (!isRemote(H)) return null
  if (H.remoteAlarms?.[ref]) return H.remoteAlarms[ref]
  if (H.heartbeatErrors?.[ref]) return H.heartbeatErrors[ref]
  try {checkHeartbeat(H, R, ref, sha); return null} catch (e) {return reason(e)}
}

// Make an object without moving its ref. The caller performs local CAS before publishing with the same old OID.
type HeartbeatArgs = [H: Handle, R: Room, who: string, target: string, text: string]
// Object construction has one named input; signing needs no custody path.
export const makeHeartbeat = (...[H, R, who, target, text]: HeartbeatArgs): string => createHeartbeat({H, R, who, target, text})
const createHeartbeat = ({H, R, who, target, text}: {H: Handle, R: Room, who: string, target: string, text: string}): string => {
  const ref = heartbeatRef(who, R.genesis)
  if (!SHA.test(target)) C.fail('heartbeat target must be a full commit id')
  if (/^Room:/m.test(text)) C.fail('heartbeat Room is transport metadata')
  const body = `Room: ${R.genesis}\n${text.trimEnd()}\n`
  heartbeatBody(body)
  const raw = `object ${target}\ntype commit\ntag ${ref.slice(TAGS.length)}\ntagger ${who} <${who}@ringi> ${Math.floor(Date.now() / 1000)} +0000\n\n${body}`
  const signature = signBytes(H, who, raw)
  const sha = git(H, ['mktag'], {input: raw + signature}).trim()
  if (isRemote(H)) checkHeartbeat(H, R, ref, sha)
  return sha
}
