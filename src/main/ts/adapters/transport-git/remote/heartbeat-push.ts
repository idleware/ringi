// heartbeat-push: a beat published with the object it replaces; a newer beat on the remote wins.

import * as C from '../../../lib/index.ts'
import {git, isRemote, locked, object, origin} from './git.ts'
import {checkHeartbeat, heartbeatRef} from './heartbeat.ts'
import {checkUrl} from './keys.ts'
import type {Handle, Room} from './types.ts'
import {SHA, TAG_ACCEPT, TAG_TRACK, TAGS} from './types.ts'

// Publish only the actor's exact heartbeat with an explicit old OID. A racing beat is ordinary contention, never a
// signal rewrite alarm. Neither success nor failure changes immutable acceptance pins or budget/history state.
export const pushHeartbeat = (H: Handle, R: Room, who: string, sha: string, expected: string | null): boolean => {
  const ref = heartbeatRef(who, R.genesis)
  if (!SHA.test(sha) || (expected !== null && !SHA.test(expected))) C.fail('heartbeat publication requires full object ids')
  if (!isRemote(H)) return true
  return locked(H, () => publishHeartbeat({H, R, ref, sha, expected}))
}

type HeartbeatPublication = {H: Handle, R: Room, ref: string, sha: string, expected: string | null}
const publishHeartbeat = ({H, R, ref, sha, expected}: HeartbeatPublication): boolean => {
  if (object(H, ref) !== sha) return false
  if (object(H, TAG_ACCEPT + ref.slice(TAGS.length))) C.fail('heartbeat namespace overlaps previously accepted signal history')
  checkHeartbeat(H, R, ref, sha)
  const url = origin(H)
  if (!url) return true
  checkUrl(url)
  const r = git(H, ['push', '-q', '--porcelain', `--force-with-lease=${ref}:${expected ?? ''}`, url, `${sha}:${ref}`], {ok: true})
  if (r.status !== 0 && !reconcileHeartbeat(H, {url, ref, sha, stdout: r.stdout, stderr: r.stderr})) return false
  git(H, ['update-ref', TAG_TRACK + ref.slice(TAGS.length), sha])
  if (H.heartbeatErrors) delete H.heartbeatErrors[ref]
  return true
}
const reconcileHeartbeat = (H: Handle, {url, ref, sha, stdout, stderr}: {url: string, ref: string, sha: string, stdout: string, stderr: string}): boolean => {
  const observed = git(H, ['ls-remote', '--refs', url, ref], {ok: true})
  const got = observed.status === 0 ? observed.stdout.trim().split(/\s+/) : []
  if (got[0] === sha && got[1] === ref) return true
  if (/\[rejected\].*\(stale info\)/.test(stdout)) return false
  return C.fail(`heartbeat push failed for ${ref.slice(TAGS.length)}: ${String(stderr || stdout || 'transport error').trim().split('\n').at(-1)}`)
}
