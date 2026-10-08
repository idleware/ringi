// The capabilities this build enforces: `<name>/<major>` → the module whose folds apply it. A new major is a new module
// registered beside the old one. A hub contract selects at most one major of each name; a room applies what its
// contract base selects (docs/ARCHITECTURE.md, Evolution).
import * as decisions from './decisions.ts'
import * as profiles from './profiles.ts'

export const CAPABILITIES: Record<string, object> = {[decisions.CAPABILITY]: decisions, [profiles.PROFILES_CAPABILITY]: profiles}
// Why a contract's capability list cannot be enforced by this build, or nothing.
export const unenforceable = (ids: string[]): string | null => {
  const names = ids.map(id => id.split('/')[0])
  const twice = names.find((n, i) => names.indexOf(n) !== i)
  if (twice) return `selects two majors of ${twice}`
  const unknown = ids.filter(id => !CAPABILITIES[id])
  return unknown.length ? `requires ${unknown.join(', ')}` : null
}
