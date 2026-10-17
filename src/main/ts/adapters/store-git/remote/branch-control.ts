// branch-control: root-signed control records and the room's roster, as a branch scan meets them.

import * as C from '../../../lib/index.ts'
import * as P from '../../../core/hub/protocol/index.ts'
import {isRemote, reason} from './git.ts'
import {rootKey} from './keys.ts'
import {rosterAt} from './roster.ts'
import {checkSignature} from './signature.ts'
import type {Handle, Raw, VerifiedRoom} from './types.ts'
import {ROOT, SHA} from './types.ts'
import {membershipChange} from './membership-change.ts'

export type Scan = {
  H: Handle, genesis: Raw, touching: Set<string>, parent: string,
  roster: Omit<VerifiedRoom, 'genesis'>, control: string[], authors: Map<string, string>, skipped: Map<string, string>
}
export const broken = (why: string): C.Fail => Object.assign(new C.Fail(why), {broken: true})
export const isControl = (s: Scan, c: Raw): boolean => c === s.genesis || (c.author === ROOT && P.parse(c.text, x => SHA.test(x)).kind === 'room')
const rootSignature = (s: Scan, c: Raw): void => {
  if (s.H.layout === 'git/4' && (c.author !== ROOT || c.committer !== ROOT || P.parse(c.text, x => SHA.test(x)).kind !== 'room')) throw broken('git/4 control must assert operator author/committer and Kind: room')
  if (!isRemote(s.H)) return
  try {checkSignature(s.H, c.sha, ROOT, rootKey(s.H))} catch (e) {
    if (c === s.genesis || C.errno(e) === 'ETIMEDOUT') throw e
    C.fail(`${reason(e)}; only the root writes control records`)
  }
}
export const acceptControl = (s: Scan, c: Raw): void => {
  rootSignature(s, c)
  let next: typeof s.roster
  try {next = rosterAt(s.H, c.sha)} catch (e) {throw broken(reason(e))}
  if (s.H.layout === 'git/4') {
    try {
      const removed = membershipChange({...s.roster, retired: s.roster.retired ?? {}}, {...next, retired: next.retired ?? {}}, c.text.split('\n')[0], isRemote(s.H), c === s.genesis)
      next.retirements = {...s.roster.retirements, ...Object.fromEntries(removed.map(actor => [actor, c.sha]))}
    } catch (e) {throw broken(reason(e))}
  } else {
    for (const e of s.roster.entries) {
      if (!next.entries.some(n => n.principal === e.principal && n.key.line === e.key.line)) throw broken('room roster drops or changes an admitted key; revocation/freeze is not implemented')
    }
  }
  s.roster = next
  s.control.push(c.sha)
}
