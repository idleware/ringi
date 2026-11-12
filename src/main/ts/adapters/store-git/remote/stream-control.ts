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
import {membershipFile} from './membership.ts'
import {invalidStream} from './stream-invalid.ts'
export type Dependencies = {controls: Set<string>, messages: Set<string>, skipped: Set<string>, retired?: Set<string>}
const control = (R: Room, c: Raw): boolean => c.sha === R.genesis || (c.author === 'operator' && P.parse(c.text, s => SHA.test(s)).kind === 'room')
export const streamDependencies = (H: Handle, R: Room): Dependencies => {
  const tip = rev(H, R.ref) ?? C.fail('room chat is missing')
  if (isRemote(H) || H.layout === 'git/4') {
    const b = branchData(H, R.name, tip, R.genesis)
    return {controls: new Set(b.control), messages: new Set(b.authors.keys()), skipped: new Set(b.skipped.keys()), retired: new Set(Object.keys(b.retirements ?? {}))}
  }
  const shas = git(H, ['rev-list', '--first-parent', '--reverse', tip, `^${R.genesis}^`]).trim().split('\n').filter(Boolean)
  const list = readCommits(H, shas)
  return {controls: new Set(list.filter(c => control(R, c)).map(c => c.sha)),
    messages: new Set(list.filter(c => !control(R, c)).map(c => c.sha)), skipped: new Set()}
}

type Authority = Pick<ReturnType<typeof rosterAt>, 'entries' | 'members'>
const authorities = new WeakMap<Handle, Map<string, Authority>>()
// A control names immutable blobs. Reuse only successful reads under the same trust and root pin.
const authorityAt = (H: Handle, control: string, signed: boolean): Authority => {
  const cache = authorities.get(H) ?? new Map<string, Authority>()
  const key = JSON.stringify([control, H.layout, H.d.trust, H.d.root])
  const known = cache.get(key)
  if (known) return known
  const authority = signed ? rosterAt(H, control) : {
    entries: [], members: membershipFile(blobText(H, control, 'members.json'), H.layout ?? 'git/3', false).members,
  }
  cache.set(key, authority)
  authorities.set(H, cache)
  if (cache.size > 256) cache.delete(cache.keys().next().value!)
  return authority
}

export const streamAdmission = (H: Handle, control: string, actor: string, sha: string): void => {
  const signed = isRemote(H)
  const {entries, members} = authorityAt(H, control, signed)
  if (signed) {
    const key = entries.find(e => e.principal === actor)?.key ?? invalidStream(`${actor} is unadmitted at stream Control`)
    try {checkSignature(H, sha, actor, key)} catch (e) {
      if (e instanceof C.Fail && (e as {invalidSignature?: boolean}).invalidSignature) invalidStream(e.message)
      throw e
    }
  } else if (!Object.hasOwn(members, actor)) invalidStream(`${actor} is unadmitted at stream Control`)
}
