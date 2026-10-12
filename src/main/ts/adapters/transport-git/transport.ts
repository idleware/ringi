// transport: the git store as a store type: a hub's repository is `store/.git` in the hub's directory; a signed hub's
// root identity comes from Signer and a published hub is replicated by bootstrap (remote/bootstrap.ts).

import {fail} from '../../lib/index.ts'
import type {Transport} from '../../core/hub/ports/store.ts'
import {GitStore} from './index.ts'
import * as Remote from './remote.ts'
import type {SigningContext} from '../../core/signing/index.ts'

type Options = {signer?: SigningContext | (() => SigningContext)}
const context = (d: {trust: string}, opt: Options) => d.trust === 'signed'
  ? (typeof opt.signer === 'function' ? opt.signer() : opt.signer) ?? fail('signed hubs require an injected Signer')
  : undefined

// `home`: where this machine keeps its state and scratch indexes; Signer owns key custody.
export const gitTransport = (home: string, opt: Options = {}): Transport => ({
  // One branch per room with its messages and control records, signals as tags on them (hub-1, Layout).
  layout: 'git/2',
  // Before contracts named it: ringi 0.1 kept a room as branches under `<room>/` (git/1).
  layoutOf: store => (store as GitStore).roomBranches().some(b => b.includes('/')) ? 'git/1' : 'git/2',
  open: (at, d) => new GitStore(at, d, home, context(d, opt)),
  create: (at, d, genesis) => {
    const signing = context(d, opt)
    if (signing) d.root = GitStore.rootFor(at, d, home, signing)
    const g = genesis(d)
    const store = GitStore.create(at, d, {home, signing}, g.files, g.text)
    if (d.trust === 'signed') d.genesis = store.contractHead()
    const custody = signing?.custody?.(d.name, 'operator') ?? null
    return {store, custody}
  },
  attach: (name, url, pins) => { Remote.hubAdd({home, name, url, ...pins}) },
})
