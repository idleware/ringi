// Stream authority is the verified chat control it names, not current membership or a server listing.
import * as C from '../../../lib/index.ts'
import * as P from '../../../core/hub/protocol/index.ts'
import {branchData} from './branch.ts'
import {readCommits} from './commits.ts'
import {git, isRemote, rev} from './git.ts'
import {rosterAt, blobText} from './roster.ts'
import {checkSignature} from './signature.ts'
import type {Handle, Raw, Room} from './types.ts'
import {SHA} from './types.ts'
export type Dependencies = {controls: Set<string>, messages: Set<string>, skipped: Set<string>}
const control = (R: Room, c: Raw): boolean => c.sha === R.genesis || (c.author === 'operator' && P.parse(c.text, s => SHA.test(s)).kind === 'room')
export const streamDependencies = (H: Handle, R: Room): Dependencies => {
  const tip = rev(H, R.ref) ?? C.fail('room chat is missing')
  if (isRemote(H)) {
    const b = branchData(H, R.name, tip, R.genesis)
    return {controls: new Set(b.control), messages: new Set(b.authors.keys()), skipped: new Set(b.skipped.keys())}
  }
  const shas = git(H, ['rev-list', '--first-parent', '--reverse', tip, `^${R.genesis}^`]).trim().split('\n').filter(Boolean)
  const list = readCommits(H, shas)
  return {controls: new Set(list.filter(c => control(R, c)).map(c => c.sha)),
    messages: new Set(list.filter(c => !control(R, c)).map(c => c.sha)), skipped: new Set()}
}
export const streamAdmission = (H: Handle, control: string, actor: string, sha: string): void => {
  if (isRemote(H)) {
    const key = rosterAt(H, control).entries.find(e => e.principal === actor)?.key ?? C.fail(`${actor} is unadmitted at stream Control`)
    checkSignature(H, sha, actor, key)
  } else {
    const members = C.strictJson<Record<string, unknown>>(blobText(H, control, 'members.json'), 'members.json')
    if (!Object.hasOwn(members, actor)) C.fail(`${actor} is unadmitted at stream Control`)
  }
}
