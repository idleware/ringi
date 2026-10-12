import {fail} from '../../lib/index.ts'
import {AGENT_RE, parse} from '../../core/hub/protocol/index.ts'
import type {SignalMigration} from './migrate-signals.ts'

const legacyTag = (m: SignalMigration, suffix: string, before: string) => {
  const name = m.prefix + suffix
  const match = /^([^/]+)\/((?:[0-9a-f]{40}|[0-9a-f]{64}))\.([a-z][a-z0-9.-]*)$/.exec(suffix)
  if (!match || !AGENT_RE.test(match[1])) return fail(`ALARM signal ${name} cannot be migrated to an unambiguous agent id`)
  const [, actor, target, signal] = match
  if (m.s.git(['cat-file', '-t', before]).trim() !== 'tag') fail(`ALARM signal ${name} is not annotated`)
  const text = m.s.git(['cat-file', 'tag', before]), split = text.indexOf('\n\n')
  const header = text.slice(0, split), body = text.slice(split + 2)
  const h = /^object ([0-9a-f]+)\ntype commit\ntag ([^\n]+)\n(tagger ([^<\n]+) <[^\n]*> \d+ [+-]\d{4})$/.exec(header)
  const agrees = h && h[1] === target && h[2] === name.slice('refs/tags/'.length)
  if (!agrees || h![4].trim() !== actor || !m.targets.has(target)) return fail(`ALARM signal ${name} disagrees with its name, actor or room target`)
  if (body.includes('-----BEGIN')) fail('signed legacy signals need their authors to sign the new names; migration stopped')
  const p = parse(body, m.s.isRef)
  for (const [k, value] of [['room', m.room], ['genesis', m.genesis], ['actor', actor], ['message', target], ['signal', signal]]) {
    if (p.trailers[k]?.length !== 1 || p.trailers[k][0] !== value) fail(`ALARM signal ${name} has inconsistent legacy metadata`)
  }
  return {actor, target, signal, tagger: h![3]}
}
export const planLegacyTag = (m: SignalMigration, suffix: string): void => {
  const {old, saved, prefix, backup} = m
  const before = saved.get(backup + suffix) ?? old.get(prefix + suffix)!
  const liveOld = old.get(prefix + suffix), recorded = saved.get(backup + suffix)
  if (recorded && liveOld && recorded !== liveOld) fail(`ALARM signal ${prefix + suffix} changed after migration; stopped`)
  const {actor, target, signal, tagger} = legacyTag(m, suffix, before)
  const key = `${actor}.${signal}.${target.slice(0, 12)}`, ref = `refs/tags/${key}`
  const after = m.s.git(['mktag'], {input: `object ${target}\ntype commit\ntag ${key}\n${tagger}\n\n`}).trim()
  const existing = m.changes.get(key), live = m.liveTags.get(ref)
  const conflictsPlanned = existing && existing.after !== after
  const conflictsLive = live && live !== after
  if (conflictsPlanned || conflictsLive) fail(`ALARM signal ${key} collides with another tag; migration stopped`)
  if (recorded && !live) fail(`ALARM migrated signal ${key} was removed; migration stopped`)
  m.changes.set(key, {before, after})
  m.identities.set(before, {key, target, signal})
  m.identities.set(after, {key, target, signal})
  if (!recorded) m.refs.push(`create ${backup + suffix} ${before}`)
  if (!live) m.refs.push(`create ${ref} ${after}`)
  if (liveOld) m.refs.push(`delete ${prefix + suffix} ${liveOld}`)
}
