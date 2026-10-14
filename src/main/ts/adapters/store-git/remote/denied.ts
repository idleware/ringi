// Only an explicit SSH access rejection is actionable as "ask the root for access". Missing repositories,
// host-key/configuration failures, timeouts and protocol/history alarms retain their own diagnostics.
import type {SpawnSyncReturns} from 'node:child_process'
import {Fail} from '../../../lib/index.ts'

export const checkSshAccess = (r: Pick<SpawnSyncReturns<string | Buffer>, 'error' | 'status' | 'stderr'>): void => {
  if (r.error || r.status === 0) return
  const denied = /Permission denied \(publickey(?:[,)]|$)|(?:repository|repo) access denied/i.test(String(r.stderr))
  if (denied) throw Object.assign(new Fail('SSH access denied; ask the root to admit this identity and grant repository access'), {code: 'denied'})
}
