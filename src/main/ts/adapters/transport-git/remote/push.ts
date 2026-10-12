// Publish one immutable ref. Room append retries preserve already returned message ids.
import * as C from '../../../lib/index.ts'
import {pushAlarms, savePushAlarms} from './alarms.ts'
import {accepted, ancestor, git, isRemote, locked, object, origin, rev, suffix, tracking, zero} from './git.ts'
import {heartbeatName} from './heartbeat.ts'
import {checkUrl} from './keys.ts'
import {recoverPublication} from './push-retry.ts'
import {validateRef} from './push-validate.ts'
import type {Handle} from './types.ts'
import {TAGS, TAG_ACCEPT, TAG_TRACK} from './types.ts'
export {validateRef} from './push-validate.ts'

export type Publication = {
  H: Handle, ref: string, alarms: Record<string, string>, tag: boolean,
  pin: string, track: string, sha: string, acc: string | null, url: string
}
const preparePublication = (H: Handle, ref: string): Omit<Publication, 'acc' | 'url'> => {
  const alarms = pushAlarms(H), tag = ref.startsWith(TAGS)
  const pin = tag ? TAG_ACCEPT + ref.slice(TAGS.length) : accepted(ref)
  const track = tag ? TAG_TRACK + ref.slice(TAGS.length) : tracking(ref)
  const sha = (tag ? object(H, ref) : rev(H, ref)) || C.fail(`no ${ref} to publish`)
  validateRef(H, ref, sha)
  return {H, ref, alarms, tag, pin, track, sha}
}
const rejectPublication = (p: Publication, behind: boolean, stdout: string): boolean => {
  let why = ''
  if (behind && !p.tag && p.ref !== 'refs/heads/main') {
    try {
      const recovered = recoverPublication(p, stdout)
      if (recovered !== null) return recovered
    } catch (e) {why = `; ${e instanceof Error ? e.message : String(e)}`}
  }
  p.alarms[p.ref] = `push rejected for ${suffix(p.ref)}; local commit ${p.sha.slice(0, 12)} retained; resolve the remote conflict before continuing${why}`
  savePushAlarms(p.H, p.alarms)
  return C.fail(`ALARM ${p.alarms[p.ref]}`)
}
const pushUnlocked = (H: Handle, ref: string, behind: boolean): boolean => {
  const prepared = preparePublication(H, ref)
  const url = origin(H)
  if (!url) return true
  checkUrl(url)
  const {tag, pin, sha, track, alarms} = prepared
  const acc = tag ? object(H, pin) : rev(H, pin)
  if (acc && (tag ? acc !== sha : !ancestor(H, acc, sha))) C.fail('ref to publish does not extend its accepted transport history')
  const p = {...prepared, acc, url}
  const r = git(H, ['push', '-q', '--porcelain', url, `${sha}:${ref}`], {ok: true})
  if (r.status !== 0) return rejectPublication(p, behind, r.stdout)
  delete alarms[ref]; savePushAlarms(H, alarms)
  git(H, ['update-ref', pin, sha, acc || zero(H)])
  git(H, ['update-ref', track, sha])
  return true
}
export const push = (H: Handle, ref: string, {behind = false}: {behind?: boolean} = {}): boolean => {
  if (heartbeatName(ref)) C.fail('heartbeat publication requires its actor and expected object id (pushHeartbeat)')
  if (!isRemote(H)) return true
  return locked(H, () => pushUnlocked(H, ref, behind))
}
