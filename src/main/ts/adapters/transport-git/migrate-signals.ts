// Legacy annotations are converted only after every pinned object has been checked.
import {fail} from '../../lib/index.ts'
import {refsUnder} from './migrate-history.ts'
import {planLegacyTag} from './migrate-tags.ts'
import {planReader, writeReader} from './migrate-readers.ts'
import type {MigrationStore} from './migrate.ts'

export type TagChange = {before: string, after: string}
export type TagIdentity = {key: string, target: string, signal: string}
export type SignalMigration = {
  s: MigrationStore, room: string, genesis: string, prefix: string, backup: string
  old: Map<string, string>, saved: Map<string, string>, liveTags: Map<string, string>
  refs: string[], changes: Map<string, TagChange>, identities: Map<string, TagIdentity>, targets: Set<string>
  kept: (sha: string) => boolean
}
export const migrateSignals = (s: MigrationStore, room: string, genesis: string, tips: string[], readers: string[]): (() => void) => {
  const prefix = `refs/tags/ringi/${genesis}/`, backup = `refs/ringi/legacy/${genesis}/signals/`
  const old = new Map(refsUnder(s, prefix)), saved = new Map(refsUnder(s, backup))
  const m: SignalMigration = {
    s, room, genesis, prefix, backup, old, saved,
    liveTags: new Map(refsUnder(s, 'refs/tags/')), refs: [], changes: new Map(), identities: new Map(),
    targets: new Set(s.git(['rev-list', ...tips, `^${genesis}`]).trim().split('\n').filter(Boolean)),
    kept: sha => tips.some(tip => s.extends(sha, tip))
  }
  for (const [ref, sha] of refsUnder(s, `refs/ringi/accepted/${genesis}/`)) {
    if (!m.kept(sha)) fail(`ALARM ${ref} lost accepted history; migration stopped`)
  }
  const suffixes = new Set([...old.keys()].map(r => r.slice(prefix.length)).concat([...saved.keys()].map(r => r.slice(backup.length))))
  for (const suffix of suffixes) planLegacyTag(m, suffix)
  const planned = readers.map(file => planReader(m, file))
  return () => {
    if (m.refs.length) s.git(['update-ref', '--stdin'], {input: ['start', ...m.refs, 'prepare', 'commit', ''].join('\n')})
    for (const p of planned) writeReader(m, p)
  }
}
