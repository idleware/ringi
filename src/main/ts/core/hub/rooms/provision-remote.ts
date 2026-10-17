// A provider result is an explicit transport locator, not a new public address or a source of credentials.
import {badRegistration as bad, record} from './registration-checks.ts'
import {storeOf} from './store-address.ts'

export const provisionRemote = (value: unknown): string => {
  if (typeof value !== 'string') return bad('invalid provisioned remote')
  const {type, locator} = storeOf(value)
  if (type !== 'git') bad('git/4 provisioning requires an explicit git locator')
  let u: URL
  try {u = new URL(locator)} catch {return bad('invalid provisioned remote')}
  if (!['ssh:', 'https:', 'file:'].includes(u.protocol)) bad('unsupported provisioned remote protocol')
  if (u.password || u.username && u.protocol !== 'ssh:') bad('provisioned remote must have no credentials, query or fragment')
  if (u.search || u.hash) bad('provisioned remote must have no credentials, query or fragment')
  return value
}
export const checkProvision = (v: unknown): void => {
  if (!record(v) || Object.keys(v).length !== 1 || !Object.hasOwn(v, 'remote')) return bad('invalid provision result')
  provisionRemote(v.remote)
}
