// push-retry: a lost acknowledgement reconciled, or one unpublished append kept and its caller moved onto the
// verified remote tip to make it again.

import * as C from '../../../lib/index.ts'
import {savePushAlarms} from './alarms.ts'
import {branchData} from './branch.ts'
import {ancestor, git, promote, rev, suffix} from './git.ts'
import type {Publication} from './push.ts'

const fetchIncoming = ({H, ref, track, url, sha, acc}: Publication): string => {
  git(H, ['-c', 'fetch.fsckObjects=true', 'fetch', '-q', '--no-tags', url, `+${ref}:${track}`])
  const incoming = rev(H, track) ?? C.fail('remote room branch is missing')
  const data = branchData(H, suffix(ref), sha)
  branchData(H, suffix(ref), incoming, data.genesis)
  if (acc && !ancestor(H, acc, incoming)) C.fail('remote room was rewritten or rolled back; retry refused')
  return incoming
}
const retryable = ({H, sha, acc}: Publication, stdout: string): boolean => {
  const parents = git(H, ['show', '-s', '--format=%P', sha]).trim().split(' ')
  const rejected = /\[rejected\].*\((?:fetch first|non-fast-forward)\)/.test(String(stdout))
  return rejected && !!acc && parents.length === 1 && parents[0] === acc
}
const retryRefs = ({H, sha, ref, pin, acc, alarms}: Publication, incoming: string): void => {
  git(H, ['update-ref', `refs/ringi/unpublished/${sha}`, sha])
  git(H, ['update-ref', ref, incoming, sha])
  git(H, ['update-ref', pin, incoming, acc!])
  delete alarms[ref]; savePushAlarms(H, alarms)
  if (H.remoteAlarms) delete H.remoteAlarms[ref]
}
export const recoverPublication = (p: Publication, stdout: string): boolean | null => {
  const incoming = fetchIncoming(p)
  if (ancestor(p.H, p.sha, incoming)) {
    // Acknowledgement lost after publication: the returned message id remains unchanged.
    promote(p.H, p.ref, incoming)
    delete p.alarms[p.ref]; savePushAlarms(p.H, p.alarms)
    return true
  }
  if (retryable(p, stdout)) {
    // Only one unpublished message is re-made by its caller; retain its original object.
    retryRefs(p, incoming)
    return false
  }
  return null
}
