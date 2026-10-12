// Resume the two room-ref transactions without changing message ids or reader baselines.
import fs from 'node:fs'
import path from 'node:path'
import {fail} from '../../lib/index.ts'
import {locked, mkdirIn} from '../fs/index.ts'
import {ID_RE, compose} from '../../core/hub/protocol/index.ts'
import {checkLegacyLogs, checkLegacyReaders, refsUnder} from './migrate-history.ts'
import {migrateSignals} from './migrate-signals.ts'

export type MigrationStore = {
  home: string, name: string, trust: string
  git: (args: string[], options?: {input?: string | Buffer}) => string
  rev: (ref: string) => string | null
  extends: (older: string, newer: string) => boolean
  isRef: (value: string) => boolean
  commit: (who: string, text: string, tree: string, parents: string[]) => string
}
export type Migration = {s: MigrationStore, name: string, ref: string, pending: string, genesis: string, readers: string[]}

const finish = ({s, ref, pending}: Migration, sha: string): string => {
  s.git(['update-ref', '--stdin'], {input: `start\ncreate ${ref} ${sha}\ndelete ${pending} ${sha}\nprepare\ncommit\n`})
  return sha
}
const stageRoom = (m: Migration, head: string, logs: Array<[string, string]>): string => {
  const {s, name, genesis, ref, pending} = m
  const sha = s.commit('operator', compose(`migrate room ${name}`, [['To', '*'], ['Kind', 'room'], ['Ringi-Layout', 'branch/1']]),
    s.git(['rev-parse', `${head}^{tree}`]).trim(), [...new Set([head, ...logs.map(([, id]) => id)])])
  const old = [[`${ref}/control`, head], ...logs]
  const backup = `refs/ringi/legacy/${genesis}/`
  s.git(['update-ref', '--stdin'], {
    input: ['start', `create ${pending} ${sha}`,
      ...old.flatMap(([r, id]) => [`create ${backup}${r.slice(`${ref}/`.length)} ${id}`, `delete ${r} ${id}`]),
      'prepare', 'commit', ''].join('\n')
  })
  return finish(m, sha)
}
const migrate = (m: Migration): string => {
  const {s, name, genesis, ref, pending, readers} = m
  if (!genesis || s.git(['show', '-s', '--format=%s', genesis]).trim() !== `room ${name}`) fail('legacy room genesis does not name this room')
  const staged = s.rev(pending), current = s.rev(ref)
  if (staged || current) {
    const tip = staged ?? current!
    const tags = migrateSignals(s, name, genesis, [tip], readers)
    if (staged) finish(m, staged)
    tags()
    return tip
  }
  const head = s.rev(`${ref}/control`) ?? fail(`no legacy room ${name}`)
  const logs = refsUnder(s, `${ref}/log/`)
  checkLegacyLogs(m, head, logs)
  checkLegacyReaders(m, head, logs)
  const tags = migrateSignals(s, name, genesis, [head, ...logs.map(([, id]) => id)], readers)
  const sha = stageRoom(m, head, logs)
  tags()
  return sha
}
const protect = (m: Migration, at: number): string => {
  if (at === m.readers.length) return migrate(m)
  const reader = path.basename(m.readers[at]).slice(0, -5)
  return locked(path.join(m.s.home, 'locks', `reader-${m.s.name}-${m.genesis.slice(0, 12)}-${reader}.lock`), () => protect(m, at + 1))
}
export const migrateRoom = (s: MigrationStore, name: string): string => {
  if (s.trust !== 'asserted') fail('legacy room migration is only supported for local asserted hubs')
  if (!ID_RE.test(name) || name === 'main') fail('expected a room id')
  const ref = `refs/heads/${name}`, pending = `refs/ringi/migrating/${name}`
  const source = s.rev(pending) ?? s.rev(ref) ?? s.rev(`${ref}/control`) ?? fail(`no legacy room ${name}`)
  const genesis = s.git(['rev-list', '--first-parent', '--reverse', source, '^refs/heads/main']).trim().split('\n')[0]
  const dir = path.join(s.home, 'readers', s.name, genesis)
  const readers = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(f => path.join(dir, f)) : []
  mkdirIn(s.home, path.join(s.home, 'locks'))
  return protect({s, name, ref, pending, genesis, readers}, 0)
}
