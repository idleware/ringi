// forget: after the operator reviews a room's transport alarm, the remote branch becomes the accepted baseline.

import {pushAlarms, savePushAlarms} from './alarms.ts'
import {branchData} from './branch.ts'
import {accepted, git, isRemote, locked, rev, tracking, zero} from './git.ts'
import type {Handle, Room} from './types.ts'

// Only the operator command calls this after reviewing a room's transport alarm: the room's branch as the remote has
// it becomes the accepted baseline, and the displaced local branch is kept as evidence. Nothing is waived: the branch
// must verify, and its invalid commits stay skipped.
export const forget = (H: Handle, R: Room): void => {
  if (!isRemote(H)) return
  return locked(H, () => {
    const alarms = pushAlarms(H)
    if (!alarms[R.ref] && !H.remoteAlarms?.[R.ref]) return
    replaceBaseline(H, R)
    delete alarms[R.ref]; savePushAlarms(H, alarms)
    if (H.remoteAlarms) delete H.remoteAlarms[R.ref]
  })
}

const replaceBaseline = (H: Handle, R: Room): void => {
  const sha = rev(H, tracking(R.ref))
  if (sha) branchData(H, R.name, sha, R.genesis)
  const old = rev(H, R.ref)
  if (old) git(H, ['update-ref', `refs/ringi/quarantine/${R.genesis}/${old}`, old])
  git(H, ['update-ref', '-d', accepted(R.ref)])
  if (sha) git(H, ['update-ref', R.ref, sha, old || zero(H)])
  else if (old) git(H, ['update-ref', '-d', R.ref, old])
}
