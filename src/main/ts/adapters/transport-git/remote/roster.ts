import * as C from '../../../lib/index.ts'
import * as P from '../../../core/hub/protocol/index.ts'
import type {Member} from '../../../core/hub/ports/store.ts'
import {git} from './git.ts'
import {parseKey, rootKey} from './keys.ts'
import type {Handle, Signer} from './types.ts'
import {ROOT} from './types.ts'

export const blobText = (H: Handle, sha: string, name: string): string => {
  const entry = git(H, ['ls-tree', sha, '--', name]).trim()
  if (!/^100(?:644|755) blob [0-9a-f]+\t/.test(entry)) C.fail(`${name} at ${sha.slice(0, 12)} must be a regular blob`)
  const raw = git(H, ['cat-file', 'blob', `${sha}:${name}`], {raw: true})
  const d = P.decodeText(raw)
  if (d.invalid) C.fail(`${name} at ${sha.slice(0, 12)} is ${d.invalid}`)
  return d.text!
}

export const rosterAt = (H: Handle, sha: string): {entries: Signer[], members: Record<string, Member>} => {
  const entries = blobText(H, sha, 'allowed_signers').split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#')).map(line => {
    const m = /^(\S+) namespaces="git" (.+)$/.exec(line) ?? C.fail('malformed allowed_signers; only literal principals and git namespace are supported')
    if (!P.ID_RE.test(m[1])) C.fail('malformed allowed_signers; only literal principals and git namespace are supported')
    return {principal: m[1], key: parseKey(m[2])}
  })
  const principals = uniqueRoster(entries)
  const members = checkedMembers(H, sha, entries, principals)
  return {entries, members}
}

const uniqueRoster = (entries: Signer[]): Set<string> => {
  const keys = new Set<string>(), principals = new Set<string>()
  for (const e of entries) {
    if (keys.has(e.key.fp) || principals.has(e.principal)) C.fail('duplicate key or principal in allowed_signers; rotation requires an explicit revocation protocol')
    keys.add(e.key.fp); principals.add(e.principal)
  }
  return principals
}

const checkedMembers = (H: Handle, sha: string, entries: Signer[], principals: Set<string>): Record<string, Member> => {
  const members = C.strictJson<Record<string, Member>>(blobText(H, sha, 'members.json'), 'members.json')
  if (!members || typeof members !== 'object' || Array.isArray(members)) C.fail('members.json must be an object')
  if (entries.find(e => e.principal === ROOT)?.key.line !== rootKey(H).line || members[ROOT]?.role !== 'root') C.fail('room roster must retain the pinned operator as root')
  if (Object.keys(members).some(who => !P.ID_RE.test(who) || !principals.has(who) || (who !== ROOT && members[who]?.role === 'root')) || entries.some(e => !members[e.principal])) C.fail('members.json and allowed_signers disagree')
  return members
}
