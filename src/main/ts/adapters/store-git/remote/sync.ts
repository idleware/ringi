// Fetch into staging refs; verify main, the pinned chat, and actor stream prefixes before promotion.
import * as C from '../../../lib/index.ts'
import {pushAlarms} from './alarms.ts'
import {isRemote, locked, origin, promote, reason, rev, suffix} from './git.ts'
import {checkUrl} from './keys.ts'
import {verifyHub, verifyMain} from './main.ts'
import {readCommits} from './commits.ts'
import {branchData} from './branch.ts'
import {selectedStreams, syncStreams} from './sync-streams.ts'
import {fetchSelected} from './fetch.ts'
import {legacyTelemetry} from './streams.ts'
import type {Handle} from './types.ts'
import {TRACK} from './types.ts'

const fetchSyncRefs = (H: Handle, url: string): Map<string, string> => {
  checkUrl(url)
  // The roster already verified here determines this fetch. Newly admitted streams arrive on the next poll.
  const known = H.endpoint && rev(H, 'refs/heads/chat') ? selectedStreams(H) : []
  return fetchSelected(H, url, ['refs/heads/main', ...(H.endpoint ? ['refs/heads/chat'] : []), ...known])
}
const syncMain = (H: Handle, fetched: Map<string, string>): void => {
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
}
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
const reportAlarms = (H: Handle): void => {
  for (const [ref, why] of Object.entries(H.remoteAlarms!)) C.note(`ALARM ${suffix(ref)}: ${why}; quarantined and withheld`)
}
const syncUnlocked = (H: Handle): Handle => {
  H.remoteAlarms = Object.fromEntries(Object.entries(pushAlarms(H)).filter(([ref]) => !legacyTelemetry(ref)))
  const url = origin(H)
  if (!url) {if (rev(H, 'refs/heads/main')) verifyHub(H); return H}
  const fetched = fetchSyncRefs(H, url)
  syncMain(H, fetched)
  syncChat(H, fetched)
  reportAlarms(H)
  return H
}
export const sync = (H: Handle): Handle => !isRemote(H) ? H : locked(H, () => syncUnlocked(H))
