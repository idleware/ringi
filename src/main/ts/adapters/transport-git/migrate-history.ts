// migrate-history: before a ringi 0.1 room moves into one branch, every log and reader of it must be linear and
// descend from the room's control record.

import fs from 'node:fs'
import path from 'node:path'
import {fail, strictJson} from '../../lib/index.ts'
import {ID_RE} from '../../core/hub/protocol/index.ts'
import type {Migration, MigrationStore} from './migrate.ts'

export const refsUnder = (s: MigrationStore, prefix: string): Array<[string, string]> =>
  s.git(['for-each-ref', '--format=%(refname) %(objectname)', prefix]).split('\n').filter(Boolean).map(l => l.split(' ') as [string, string])
const checkLinear = (s: MigrationStore, genesis: string, ref: string, sha: string, who: string): void => {
  if (!ID_RE.test(who) || !s.extends(genesis, sha)) fail(`ALARM ${ref} does not descend from its room genesis`)
  const commits = s.git(['rev-list', '--parents', '--reverse', sha, `^${genesis}`]).trim().split('\n').filter(Boolean)
  let parent = genesis
  for (const row of commits) {
    const [id, ...parents] = row.split(' ')
    if (parents.length !== 1 || parents[0] !== parent) fail(`ALARM ${ref} is not linear`)
    if (s.git(['show', '-s', '--format=%an', id]).trim() !== who) fail(`ALARM ${ref} contains another author's message`)
    parent = id
  }
}
export const checkLegacyLogs = ({s, ref, genesis}: Migration, head: string, logs: Array<[string, string]>): void => {
  for (const [r, sha] of [[`${ref}/control`, head], ...logs]) {
    checkLinear(s, genesis, r, sha, r === `${ref}/control` ? 'operator' : r.slice(`${ref}/log/`.length))
  }
}
export const checkLegacyReaders = ({s, ref, genesis, readers}: Migration, head: string, logs: Array<[string, string]>): void => {
  const byAuthor = new Map(logs.map(([r, sha]) => [r.slice(`${ref}/log/`.length), sha]))
  const check = (who: string, sha: string) => {
    const tip = byAuthor.get(who)
    if (!tip || !s.extends(sha, tip)) fail(`ALARM log ${who} lost accepted history; migration stopped`)
  }
  for (const [r, sha] of refsUnder(s, `refs/ringi/accepted/${genesis}/`)) check(r.split('/').at(-1)!, sha)
  for (const file of readers) {
    const st = strictJson<{control?: string, heads?: Record<string, string>}>(fs.readFileSync(file, 'utf8'), path.basename(file))
    if (st.control && !s.extends(st.control, head)) fail('ALARM room control lost accepted history; migration stopped')
    for (const [who, sha] of Object.entries(st.heads ?? {})) check(who, sha)
  }
}
