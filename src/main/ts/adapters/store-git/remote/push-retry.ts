// push-retry: a lost acknowledgement reconciled, or one unpublished append kept and its caller moved onto the
// verified remote tip to make it again.

import * as C from '../../../lib/index.ts'
import {savePushAlarms} from './alarms.ts'
import {validateRef} from './push-validate.ts'
import {branchData} from './branch.ts'
import {readCommits} from './commits.ts'
import {verifyMain} from './main.ts'
import {ancestor, git, networkGit, promote, rev, tracking, zero} from './git.ts'
import {streamName} from './streams.ts'
import type {Publication} from './push.ts'

const fetchIncoming = ({H, ref, track, url, sha, acc}: Publication): string => {
  networkGit(H, ['-c', 'fetch.fsckObjects=true', 'fetch', '-q', '--no-tags', url, `+${ref}:${track}`])
  networkGit(H, ['-c', 'fetch.fsckObjects=true', 'fetch', '-q', '--no-tags', url, `+refs/heads/main:${tracking('refs/heads/main')}`])
  const main = rev(H, tracking('refs/heads/main')) ?? C.fail('remote main is missing')
  verifyMain(H, main)
  if (H.endpoint && readCommits(H, [H.endpoint.genesis])[0].parents[0] !== main) C.fail('the room main changed its frozen contract')
  promote(H, 'refs/heads/main', main)
  if (streamName(ref)) {
    networkGit(H, ['-c', 'fetch.fsckObjects=true', 'fetch', '-q', '--no-tags', url, `+refs/heads/chat:${tracking('refs/heads/chat')}`])
    const chat = rev(H, tracking('refs/heads/chat')) ?? C.fail('remote chat is missing')
    const endpoint = H.endpoint ?? C.fail('stream retry requires its room endpoint')
    branchData(H, endpoint.name, chat, endpoint.genesis); promote(H, 'refs/heads/chat', chat)
  }
  const incoming = rev(H, track) ?? C.fail('remote room branch is missing')
  validateRef(H, ref, sha)
  validateRef(H, ref, incoming)
  if (acc && !ancestor(H, acc, incoming)) C.fail('remote room was rewritten or rolled back; retry refused')
  return incoming
}
const retryable = ({H, sha, acc, ref}: Publication, stdout: string): boolean => {
  const parents = git(H, ['show', '-s', '--format=%P', sha]).trim().split(' ')
  const rejected = /\[rejected\].*\((?:fetch first|non-fast-forward)\)/.test(String(stdout))
  const base = acc ?? (streamName(ref) ? H.endpoint?.genesis : undefined)
  return rejected && !!base && parents.length === 1 && parents[0] === base
}
const retryRefs = ({H, sha, ref, pin, acc, alarms}: Publication, incoming: string): void => {
  git(H, ['update-ref', `refs/ringi/unpublished/${sha}`, sha])
  git(H, ['update-ref', ref, incoming, sha])
  git(H, ['update-ref', pin, incoming, acc ?? zero(H)])
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
