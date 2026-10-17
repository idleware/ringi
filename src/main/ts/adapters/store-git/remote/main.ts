// main: the hub's contract branch verified: every commit signed by the root since the pinned genesis.

import * as C from '../../../lib/index.ts'
import {memo} from './cache.ts'
import {isRemote, rev} from './git.ts'
import {parseKey, rootKey} from './keys.ts'
import {blobText} from './roster.ts'
import {chain, checkSignature, linear} from './signature.ts'
import type {Handle, Key} from './types.ts'
import {ROOT} from './types.ts'
import {readCommits} from './commits.ts'

export const verifyMain = (H: Handle, head: string): {head: string, genesis: string, commits: string[]} => memo(H, `main/${head}`, () => {
  const key = isRemote(H) ? rootKey(H) : undefined
  const commits = chain(H, head)
  if (!commits.length) C.fail('hub has no genesis')
  const pin = H.d.genesis
  if (!pin && !H.bootstrap) C.fail(`hub ${H.name} has no pinned genesis`)
  if (pin && commits[0].sha !== pin) C.fail('hub does not descend from the pinned genesis')
  linear(commits, null, sha => checkContract(H, sha, key))
  if (!pin) H.d.genesis = commits[0].sha
  H.bootstrap = false
  return {head, genesis: commits[0].sha, commits: commits.map(c => c.sha)}
})

export const verifyHub = (H: Handle) => {
  if (!isRemote(H) && H.layout !== 'git/4') return null
  const head = rev(H, 'refs/heads/main') || C.fail('hub has no main')
  return verifyMain(H, head)
}

type ContractTrust = {schema: string, trust: string, root?: string}
const checkAsserted = (H: Handle, sha: string, meta: ContractTrust): void => {
  const c = readCommits(H, [sha])[0]
  if (c.author !== ROOT || c.committer !== ROOT) C.fail('asserted contract must name operator as author and committer')
  if (H.layout !== 'git/4' || H.d.root) C.fail('asserted contract validation requires explicit git/4 without a signing root')
  if (meta.schema !== 'ringi-hub' || meta.trust !== 'asserted' || meta.root !== undefined) C.fail('contract.json must declare asserted trust without a signing root')
}
const checkContract = (H: Handle, sha: string, key?: Key): void => {
  if (key) checkSignature(H, sha, ROOT, key)
  const name = 'contract.json', meta = C.strictJson<ContractTrust>(blobText(H, sha, name), name)
  if (!key) return checkAsserted(H, sha, meta)
  if (meta.schema !== 'ringi-hub' || meta.trust !== 'signed' || parseKey(meta.root).line !== key.line) C.fail(`${name} must declare signed trust and the pinned root key`)
}
