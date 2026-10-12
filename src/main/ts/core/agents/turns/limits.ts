// limits: the watcher's options checked before it starts.

import {fail} from '../../../lib/index.ts'
import type {WatchOptions} from './types.ts'
export const validateWatch = (w: WatchOptions): void => {
  for (const [name, value] of [['interval', w.interval], ['window', w.window]] as const)
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) fail(`watch ${name} must be positive seconds`)
  for (const [name, value] of [['max-runs', w.maxRuns], ['max-hop', w.maxHop]] as const)
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) fail(`watch ${name} must be a nonnegative integer`)
}
