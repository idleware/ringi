// branch-scan: a room's branch scanned from its genesis to a tip.

import * as C from '../../../lib/index.ts'
import {visitCommit} from './branch-commit.ts'
import type {Scan} from './branch-control.ts'
import {readCommits} from './commits.ts'
import {git} from './git.ts'
import {verifyHub} from './main.ts'
import type {Branch, Handle} from './types.ts'
import {CONTROL_FILES} from './types.ts'

export const scanBranch = (H: Handle, name: string, tip: string): Branch => {
  const main = verifyHub(H) ?? C.fail('room verification requires a signed hub')
  const shas = git(H, ['rev-list', '--first-parent', '--reverse', tip, `^${main.head}`]).trim().split('\n').filter(Boolean)
  if (!shas.length) C.fail(`room ${name} has no genesis`)
  const list = readCommits(H, shas), genesis = list[0]
  if (genesis.parents.length !== 1 || !main.commits.includes(genesis.parents[0])) C.fail('room does not descend from the verified hub contract')
  const touching = new Set(git(H, ['log', '--first-parent', '--format=%H', tip, `^${main.head}`, '--', ...CONTROL_FILES]).trim().split('\n').filter(Boolean))
  const scan: Scan = {
    H, genesis, touching, parent: genesis.parents[0], roster: {entries: [], members: {}},
    control: [], authors: new Map(), skipped: new Map()
  }
  for (const c of list) visitCommit(scan, c)
  return {
    genesis: genesis.sha, subject: genesis.text.split('\n')[0], ...scan.roster,
    control: scan.control, authors: scan.authors, skipped: scan.skipped
  }
}
