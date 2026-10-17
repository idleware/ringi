// Full registered identity is committed into one safe path segment; URLs never become LocalState path components.
import {createHash} from 'node:crypto'
import {fail} from '../../../lib/index.ts'
import {registrationId} from './room-registration.ts'
import {revision, token} from './registration-checks.ts'
import type {RoomV2} from './index.ts'

export const contextToken = (R: Pick<RoomV2, 'context'>): string => {
  const c = R.context
  if (!Array.isArray(c) || c.length !== 5 || c[0] !== registrationId(c[1])) return fail('invalid registered room context')
  if (!revision(c[2]) || !revision(c[3]) || !token(c[4])) fail('invalid registered room history or incarnation context')
  return createHash('sha256').update(JSON.stringify(c)).digest('hex')
}
