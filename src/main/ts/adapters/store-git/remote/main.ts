// main: the hub's contract branch verified: every commit signed by the root since the pinned genesis.

import * as C from '../../../lib/index.ts'
import {memo} from './cache.ts'
import {isRemote, rev} from './git.ts'
import {parseKey, rootKey} from './keys.ts'
import {blobText} from './roster.ts'
import {chain, checkSignature, linear} from './signature.ts'
import type {Handle, Key} from './types.ts'
import {ROOT} from './types.ts'

export const verifyMain = (H: Handle, head: string): {head: string, genesis: string, commits: string[]} => memo(H, `main/${head}`, () => {
  const key = rootKey(H)
  const commits = chain(H, head)
  if (!commits.length) C.fail('signed hub has no genesis')
  const pin = H.d.genesis
  if (!pin && !H.bootstrap) C.fail(`hub ${H.name} has no pinned genesis`)
  if (pin && commits[0].sha !== pin) C.fail('hub does not descend from the pinned genesis')
  linear(commits, null, sha => checkContract(H, sha, key))
  if (!pin) H.d.genesis = commits[0].sha
  H.bootstrap = false
  return {head, genesis: commits[0].sha, commits: commits.map(c => c.sha)}
})

export const verifyHub = (H: Handle) => {
  if (!isRemote(H)) return null
  const head = rev(H, 'refs/heads/main') || C.fail('signed hub has no main')
  return verifyMain(H, head)
}

const checkContract = (H: Handle, sha: string, key: Key): void => {
  checkSignature(H, sha, ROOT, key)
  const name = 'contract.json'
  const meta = C.strictJson<{schema: string, trust: string, root: string}>(blobText(H, sha, name), name)
  if (meta.schema !== 'ringi-hub' || meta.trust !== 'signed' || parseKey(meta.root).line !== key.line) C.fail(`${name} must declare signed trust and the pinned root key`)
}
