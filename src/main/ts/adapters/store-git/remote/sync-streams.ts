// Fetch-stage actor heads verified against the pinned chat; partial suffixes never replace evidence.
import * as C from '../../../lib/index.ts'
import {accepted, ancestor, promote, reason, refs, rev, suffix} from './git.ts'
import {scanStream, streamName, streamRoom} from './streams.ts'
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
export const syncStreams = (H: Handle, fetched: Map<string, string>): void => {
  const names = [...fetched.keys(), ...refs(H, 'refs/ringi/remote-accepted/').keys()]
    .map(r => r.replace(/^refs\/(?:remotes\/origin|ringi\/remote-accepted)\//, 'refs/heads/')).filter(r => streamName(r))
  for (const ref of new Set(names)) syncActor(H, fetched, ref)
}
