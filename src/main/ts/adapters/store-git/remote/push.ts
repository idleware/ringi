// Publish one immutable ref. Room append retries preserve already returned message ids.
import * as C from '../../../lib/index.ts'
import {pushAlarms, savePushAlarms} from './alarms.ts'
import {accepted, ancestor, git, isRemote, locked, origin, rev, suffix, tracking, zero} from './git.ts'
import {checkUrl} from './keys.ts'
import {recoverPublication} from './push-retry.ts'
import {validateRef} from './push-validate.ts'
import type {Handle} from './types.ts'
export {validateRef} from './push-validate.ts'

export type Publication = {
  H: Handle, ref: string, alarms: Record<string, string>,
  pin: string, track: string, sha: string, acc: string | null, url: string
}
const preparePublication = (H: Handle, ref: string): Omit<Publication, 'acc' | 'url'> => {
  const alarms = pushAlarms(H), pin = accepted(ref), track = tracking(ref)
  const sha = rev(H, ref) || C.fail(`no ${ref} to publish`)
  validateRef(H, ref, sha)
  return {H, ref, alarms, pin, track, sha}
}
const rejectPublication = (p: Publication, behind: boolean, stdout: string): boolean => {
  let why = ''
  if ((behind || /\/(signals|telemetry)$/.test(p.ref)) && p.ref !== 'refs/heads/main') {
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
  const {pin, sha, track, alarms} = prepared
  const acc = rev(H, pin)
  if (acc && !ancestor(H, acc, sha)) C.fail('ref to publish does not extend its accepted transport history')
  // Replaying a known tuple can retry its retained unpublished head. A healthy acknowledged head needs no push.
  if (acc === sha && !alarms[ref] && !H.remoteAlarms?.[ref]) return true
  const p = {...prepared, acc, url}
  const r = git(H, ['push', '-q', '--porcelain', url, `${sha}:${ref}`], {ok: true})
  if (r.status !== 0) return rejectPublication(p, behind, r.stdout)
  delete alarms[ref]; savePushAlarms(H, alarms)
  if (H.remoteAlarms) delete H.remoteAlarms[ref]
  git(H, ['update-ref', pin, sha, acc || zero(H)])
  git(H, ['update-ref', track, sha])
  return true
}
export const push = (H: Handle, ref: string, {behind = false}: {behind?: boolean} = {}): boolean => {
  if (!isRemote(H)) return true
  return locked(H, () => pushUnlocked(H, ref, behind))
}
