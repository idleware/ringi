// One accepted root control may retire one whole member. No rotation, keyset or historical cutoff is inferred.
import {fail} from '../../../lib/index.ts'
import type {Membership} from './membership.ts'
import type {Signer} from './types.ts'

type Snapshot = Membership & {entries: Signer[]}
const unchangedRetired = (before: Membership, after: Membership): void => {
  for (const [who, old] of Object.entries(before.retired)) {
    const next = Object.hasOwn(after.retired, who) ? after.retired[who] : undefined
    if (!next || next.key !== old.key || next.since !== old.since) fail('retired membership is immutable and may only grow')
  }
}
const retainedKeys = (before: Snapshot, after: Snapshot): void => {
  for (const e of before.entries) {
    if (!Object.hasOwn(after.members, e.principal)) continue
    if (!after.entries.some(n => n.principal === e.principal && n.key.line === e.key.line)) fail('an admitted actor key cannot change')
  }
}
const removedMember = (before: Snapshot, after: Snapshot, who: string, signed: boolean): void => {
  const retired = after.retired[who]
  const key = signed ? before.entries.find(e => e.principal === who)?.key.fp : null
  if (!retired || key === undefined || retired.key !== key) fail('removed member must retain its exact previous fingerprint in retired')
}
export const membershipChange = (before: Snapshot, after: Snapshot, subject: string, signed: boolean, genesis = false): string[] => {
  unchangedRetired(before, after)
  retainedKeys(before, after)
  const removed = Object.keys(before.members).filter(who => !Object.hasOwn(after.members, who))
  const addedRetired = Object.keys(after.retired).filter(who => !Object.hasOwn(before.retired, who))
  if (genesis && addedRetired.length) fail('room genesis cannot contain preexisting retirements')
  if (removed.length !== addedRetired.length || removed.some(who => !addedRetired.includes(who))) fail('every new retirement must remove one existing member')
  if (removed.length > 1 || removed.length === 1 && subject !== `remove ${removed[0]}`) fail('member removal requires its explicit remove <actor> root control')
  for (const who of removed) removedMember(before, after, who, signed)
  return removed
}
