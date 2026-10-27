// Fetch-stage actor heads verified against the pinned chat; partial suffixes never replace evidence.
import * as C from '../../../lib/index.ts'
import {accepted, ancestor, promote, reason, refs, rev, suffix} from './git.ts'
import {scanStream, streamName, streamRoom, streamRef} from './streams.ts'
import {branchData} from './branch.ts'
import {streamEvidence} from './stream-evidence.ts'
import type {Handle} from './types.ts'
import {TRACK} from './types.ts'
const syncActor = (H: Handle, fetched: Map<string, string>, ref: string): void => {
  const name = streamName(ref)!, R = streamRoom(H)
  try {
    const head = fetched.get(TRACK + suffix(ref)) ?? C.fail('accepted actor stream was deleted')
    const acc = rev(H, accepted(ref)), checked = scanStream({H, R, ...name, head})
    if (acc && !ancestor(H, acc, head)) C.fail('actor stream rewrites its accepted prefix')
    if (checked.head !== R.genesis) promote(H, ref, checked.head)
    if (checked.why) C.fail(checked.why)
  } catch (err) {H.remoteAlarms![ref] = reason(err)}
}
const retainedRefs = (H: Handle): string[] => [...refs(H, 'refs/ringi/remote-accepted/').keys()]
  .map(r => r.replace('refs/ringi/remote-accepted/', 'refs/heads/')).filter(r => streamName(r))
export const selectedStreams = (H: Handle): string[] => {
  const R = streamRoom(H), b = branchData(H, R.name, R.head, R.genesis)
  const actors = new Set([...Object.keys(b.members), ...Object.keys(b.retired ?? {}), ...streamEvidence(H, R).keys()])
  return [...new Set([...actors].map(streamRef).concat(retainedRefs(H)))]
}
export const syncStreams = (H: Handle, fetched: Map<string, string>): void => {
  const names = [...fetched.keys()].map(r => r.replace(/^refs\/remotes\/origin\//, 'refs/heads/')).filter(r => streamName(r))
  names.push(...retainedRefs(H), ...[...streamEvidence(H, streamRoom(H)).keys()].map(streamRef))
  for (const ref of new Set(names)) syncActor(H, fetched, ref)
}
