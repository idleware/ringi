// admit: a member's key on a signed hub: made on its machine (join) and admitted by the root in a control record.

import * as C from '../../../lib/index.ts'
import * as P from '../../../core/hub/protocol/index.ts'
import {branch, verifyRoom} from './branch.ts'
import {git, id, ident, isRemote, locked, rev} from './git.ts'
import {keyInput, identityKey, sign, signerLine} from './keys.ts'
import {signCommit} from '../signing.ts'
import {push} from './push.ts'
import type {Branch, Handle, Key, Room} from './types.ts'
import {CONTROL_FILES, ROOT} from './types.ts'

export const join = (H: Handle, R: Room, who: string, home: string) => {
  const room = verifyRoom(H, R)
  const key = locked(H, () => identityKey(H, who, home, true))
  const admitted = !!room.entries.find(e => e.principal === who && e.key.line === key.line)
  return {publicKey: key.line, fingerprint: key.fp, admitted}
}

// A tree from `base` with the control files as `control` has them, then `patches` on top.
const treeWith = (H: Handle, base: string, control: string, patches: Record<string, string>): string => {
  const entries = (sha: string) => new Map(git(H, ['ls-tree', sha]).trim().split('\n').filter(Boolean).map(line => {
    const m = /^(\d+) (\w+) ([0-9a-f]+)\t(.+)$/.exec(line) ?? C.fail('malformed room tree')
    return [m[4], line] as [string, string]
  }))
  const files = entries(base), kept = entries(control)
  for (const name of CONTROL_FILES) {files.delete(name); if (kept.has(name)) files.set(name, kept.get(name)!)}
  for (const [name, content] of Object.entries(patches)) files.set(name, `100644 blob ${git(H, ['hash-object', '-w', '--stdin'], {input: content}).trim()}\t${name}`)
  return git(H, ['mktree'], {input: [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, line]) => line).join('\n') + '\n'}).trim()
}

// The root's control record admitting a member, on top of the room's branch: the key and the member go in together.
export const roomAdmit = (H: Handle, R: Room, who: string, publicKey: string, home: string): string => {
  const key = admissionKey(H, R, who, publicKey)
  for (let attempt = 0;attempt < 8;attempt++) {
    const tip = rev(H, R.ref) ?? C.fail('room branch is missing')
    const room = branch(H, R, tip), head = room.control.at(-1)!
    if (room.entries.some(e => e.principal === who || e.key.fp === key.fp)) C.fail('principal or key is already admitted; key rotation is not implemented')
    const {sha, members} = admissionCommit({H, R, who, home, tip, head, room, key})
    if (git(H, ['update-ref', R.ref, sha, tip], {ok: true}).status !== 0) continue
    if (!push(H, R.ref, {behind: true})) continue
    R.head = sha; R.members = members
    return sha
  }
  return C.fail('room kept moving while admitting; retry')
}

type Admission = {H: Handle, R: Room, who: string, home: string, tip: string, head: string, room: Branch, key: Key}
const admissionCommit = ({H, who, home, tip, head, room, key}: Admission) => {
  const members = {...room.members, [who]: {role: 'member', since: new Date().toISOString()}}
  const roster = [...room.entries.map(e => signerLine(e.principal, e.key)), signerLine(who, key)].join('')
  const tree = treeWith(H, tip, head, {'members.json': JSON.stringify(members, null, 2) + '\n', allowed_signers: roster})
  const sha = git(H, ['commit-tree', ...(H.signing ? [] : sign(H, ROOT, home)), tree, '-p', tip], {
    input: P.compose(`admit ${who}`, [['To', '*'], ['Kind', 'room'], ['Key', key.fp]]), env: ident(ROOT),
  }).trim()
  return {sha: signCommit(H, ROOT, sha, home), members}
}

const admissionKey = (H: Handle, R: Room, who: string, publicKey: string): Key => {
  id(who)
  if (!isRemote(H)) C.fail('room admit is for signed hubs; local membership is added by join')
  if (who === ROOT) C.fail('the root is already pinned; root replacement requires a separate trust transition')
  if (R.archived) C.fail('cannot admit into an archived room')
  const key = keyInput(publicKey)
  return key
}
