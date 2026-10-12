// branch-commit: one commit of a room's branch, judged: a control record, a valid message of an admitted author, or
// skipped with the reason.

import * as C from '../../../lib/index.ts'
import type {Scan} from './branch-control.ts'
import {acceptControl, broken, isControl} from './branch-control.ts'
import {reason} from './git.ts'
import {checkSignature} from './signature.ts'
import type {Raw} from './types.ts'

const acceptMessage = (s: Scan, c: Raw): void => {
  const signer = s.roster.entries.find(e => e.principal === c.author) ?? C.fail(`${c.author || 'its author'} is unadmitted in this room`)
  if (s.touching.has(c.sha)) C.fail('it changes the room\'s control files, which only the root changes')
  checkSignature(s.H, c.sha, c.author, signer.key)
  s.authors.set(c.sha, c.author)
}
const fatal = (s: Scan, c: Raw, e: unknown): boolean => {
  if (!(e instanceof C.Fail)) return true
  const brokenRoom = c === s.genesis || (e as {broken?: boolean}).broken
  return !!brokenRoom || C.errno(e) === 'ETIMEDOUT'
}
export const visitCommit = (s: Scan, c: Raw): void => {
  if (c.parents.length !== 1 || c.parents[0] !== s.parent) throw broken('a merge or non-linear history; a room is one linear branch')
  s.parent = c.sha
  try {
    if (isControl(s, c)) acceptControl(s, c)
    else acceptMessage(s, c)
  } catch (e) {
    if (fatal(s, c, e)) throw e
    s.skipped.set(c.sha, reason(e))
  }
}
