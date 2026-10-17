// admit: a member's key on a signed hub: made on its machine (join) and admitted by the root in a control record.

import * as C from '../../../lib/index.ts'
import * as P from '../../../core/hub/protocol/index.ts'
import {branch, verifyRoom} from './branch.ts'
import {git, ident, isRemote, locked, rev} from './git.ts'
import {identityKey, signerLine} from './keys.ts'
import {signCommit} from '../signing.ts'
import {push} from './push.ts'
import type {Branch, Handle, Key, Room} from './types.ts'
import {ROOT} from './types.ts'
import {membershipText} from './membership.ts'
import {treeWith} from './control-tree.ts'
export {treeWith} from './control-tree.ts'
import {admissionKey, admissionRetry} from './admission-policy.ts'

export const join = (H: Handle, R: Room, who: string) => {
  if (!isRemote(H)) return C.fail('asserted membership has no signing identity or key admission')
  const room = H.layout === 'git/4' ? branch(H, R, rev(H, R.ref) ?? C.fail('room branch is missing')) : verifyRoom(H, R)
  if (H.layout === 'git/4' && Object.hasOwn(room.retired ?? {}, who)) C.fail('actor is permanently retired in this room')
  const key = locked(H, () => identityKey(H, who, true))
  const admitted = !!room.entries.find(e => e.principal === who && e.key.line === key.line)
  return {publicKey: key.line, fingerprint: key.fp, admitted}
}

// The root's control record admitting a member, on top of the room's branch: the key and the member go in together.
const admissionAttempt = (H: Handle, R: Room, who: string, key: Key): string | null => {
  const tip = rev(H, R.ref) ?? C.fail('room branch is missing')
  const room = branch(H, R, tip), head = room.control.at(-1)!
  const existing = admissionRetry(H, room, who, key)
  if (existing) return push(H, R.ref, {behind: true}) ? existing : null
  const {sha, members} = admissionCommit({H, R, who, tip, head, room, key})
  if (git(H, ['update-ref', R.ref, sha, tip], {ok: true}).status !== 0) return null
  if (!push(H, R.ref, {behind: true})) return null
  R.head = sha; R.members = members
  return sha
}
export const roomAdmit = (H: Handle, R: Room, who: string, publicKey: string): string => {
  if (!isRemote(H)) return C.fail('asserted membership uses explicit operator controls, not signing-key admission')
  const key = admissionKey(H, who, publicKey)
  for (let attempt = 0; attempt < 8; attempt++) {
    const published = admissionAttempt(H, R, who, key)
    if (published) return published
  }
  return C.fail('room kept moving while admitting; retry')
}

type Admission = {H: Handle, R: Room, who: string, tip: string, head: string, room: Branch, key: Key}
const admissionCommit = ({H, who, tip, head, room, key}: Admission) => {
  const members = {...room.members, [who]: {role: 'member', since: new Date().toISOString()}}
  const roster = [...room.entries.map(e => signerLine(e.principal, e.key)), signerLine(who, key)].join('')
  const tree = treeWith(H, tip, head, {'members.json': membershipText({members, retired: room.retired ?? {}}, H.layout ?? 'git/3'), allowed_signers: roster})
  const sha = git(H, ['commit-tree', tree, '-p', tip], {
    input: P.compose(`admit ${who}`, [['To', '*'], ['Kind', 'room'], ['Key', key.fp]]), env: ident(ROOT),
  }).trim()
  return {sha: signCommit(H, ROOT, sha), members}
}
