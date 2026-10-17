// roster: who may sign a room's logs at a control record: its signers file and members, checked against each other.

import * as C from '../../../lib/index.ts'
import * as P from '../../../core/hub/protocol/index.ts'
import type {Member} from '../../../core/hub/ports/store.ts'
import {git, isRemote} from './git.ts'
import {parseKey, rootKey} from './keys.ts'
import type {Handle, Signer} from './types.ts'
import {ROOT} from './types.ts'
import {checkRetiredKeys, membershipFile} from './membership.ts'
import type {RetiredMember} from './membership.ts'

export const blobText = (H: Handle, sha: string, name: string): string => {
  const entry = git(H, ['ls-tree', sha, '--', name]).trim()
  if (!/^100(?:644|755) blob [0-9a-f]+\t/.test(entry)) C.fail(`${name} at ${sha.slice(0, 12)} must be a regular blob`)
  const raw = git(H, ['cat-file', 'blob', `${sha}:${name}`], {raw: true})
  const d = P.decodeText(raw)
  if (d.invalid) C.fail(`${name} at ${sha.slice(0, 12)} is ${d.invalid}`)
  return d.text!
}

export const rosterAt = (H: Handle, sha: string): {entries: Signer[], members: Record<string, Member>, retired?: Record<string, RetiredMember>} => {
  if (!isRemote(H)) return assertedRoster(H, sha)
  const entries = blobText(H, sha, 'allowed_signers').split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#')).map(line => {
    const m = /^(\S+) namespaces="git" (.+)$/.exec(line) ?? C.fail('malformed allowed_signers; only literal principals and git namespace are supported')
    if (!P.ID_RE.test(m[1])) C.fail('malformed allowed_signers; only literal principals and git namespace are supported')
    return {principal: m[1], key: parseKey(m[2])}
  })
  const principals = uniqueRoster(entries)
  const state = membershipFile(blobText(H, sha, 'members.json'), H.layout ?? 'git/3', true)
  const members = checkedMembers(H, state.members, entries, principals)
  checkRetiredKeys(state, entries)
  return H.layout === 'git/4' ? {entries, members, retired: state.retired} : {entries, members}
}

// Asserted authority is the explicit operator name/control model. It never manufactures a cryptographic signer.
const assertedRoster = (H: Handle, sha: string) => {
  if (H.layout !== 'git/4') return C.fail('asserted roster validation requires explicit git/4')
  const signers = git(H, ['ls-tree', sha, '--', 'allowed_signers']).trim()
  if (signers && blobText(H, sha, 'allowed_signers').trim()) C.fail('asserted control cannot declare cryptographic signers')
  const state = membershipFile(blobText(H, sha, 'members.json'), 'git/4', false)
  return {entries: [], ...state}
}

const uniqueRoster = (entries: Signer[]): Set<string> => {
  const keys = new Set<string>(), principals = new Set<string>()
  for (const e of entries) {
    if (keys.has(e.key.fp) || principals.has(e.principal)) C.fail('duplicate key or principal in allowed_signers; rotation requires an explicit revocation protocol')
    keys.add(e.key.fp); principals.add(e.principal)
  }
  return principals
}

const checkedMembers = (H: Handle, members: Record<string, Member>, entries: Signer[], principals: Set<string>): Record<string, Member> => {
  if (!members || typeof members !== 'object' || Array.isArray(members)) C.fail('members.json must be an object')
  if (entries.find(e => e.principal === ROOT)?.key.line !== rootKey(H).line || members[ROOT]?.role !== 'root') C.fail('room roster must retain the pinned operator as root')
  if (Object.keys(members).some(who => !P.ID_RE.test(who) || !principals.has(who) || (who !== ROOT && members[who]?.role === 'root')) || entries.some(e => !Object.hasOwn(members, e.principal))) C.fail('members.json and allowed_signers disagree')
  return members
}
