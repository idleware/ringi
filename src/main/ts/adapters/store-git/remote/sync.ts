// Fetch into staging refs; verify main, the pinned chat, and actor stream prefixes before promotion.
import * as C from '../../../lib/index.ts'
import {pushAlarms} from './alarms.ts'
import {isRemote, locked, networkGit, origin, promote, reason, refs, rev, suffix} from './git.ts'
import {checkUrl} from './keys.ts'
import {verifyHub, verifyMain} from './main.ts'
import {readCommits} from './commits.ts'
import {branchData} from './branch.ts'
import {syncStreams} from './sync-streams.ts'
import {legacyTelemetry} from './streams.ts'
import type {Handle} from './types.ts'
import {TRACK} from './types.ts'

const syncChat = (H: Handle, fetched: Map<string, string>): void => {
  const e = H.endpoint
  if (!e) return
  const ref = 'refs/heads/chat'
  try {
    const head = fetched.get(TRACK + 'chat') ?? C.fail('remote chat was deleted or is missing')
    branchData(H, e.name, head, e.genesis)
    promote(H, ref, head)
  } catch (err) {H.remoteAlarms![ref] = reason(err); return}
  syncStreams(H, fetched)
}
const syncUnlocked = (H: Handle): Handle => {
  H.remoteAlarms = Object.fromEntries(Object.entries(pushAlarms(H)).filter(([ref]) => !legacyTelemetry(ref)))
  const url = origin(H)
  if (!url) {if (rev(H, 'refs/heads/main')) verifyHub(H); return H}
  checkUrl(url)
  networkGit(H, ['-c', 'fetch.fsckObjects=true', 'fetch', '-q', '--no-tags', '--prune', url, `+refs/heads/*:${TRACK}*`])
  const fetched = refs(H, TRACK)
  const main = fetched.get(TRACK + 'main') || C.fail('ALARM remote main was deleted or is missing; nothing is delivered')
  try {
    verifyMain(H, main)
    if (H.endpoint) {
      const genesis = readCommits(H, [H.endpoint.genesis])[0]
      if (genesis.parents.length !== 1 || genesis.parents[0] !== main) C.fail('the room main changed its frozen contract')
    }
    promote(H, 'refs/heads/main', main)
  } catch (err) {C.fail(`ALARM hub ${H.name}: ${reason(err)}; nothing is delivered`)}
  H.main = rev(H, 'refs/heads/main')!
  syncChat(H, fetched)
  for (const [ref, why] of Object.entries(H.remoteAlarms)) C.note(`ALARM ${suffix(ref)}: ${why}; quarantined and withheld`)
  return H
}
export const sync = (H: Handle): Handle => !isRemote(H) ? H : locked(H, () => syncUnlocked(H))
