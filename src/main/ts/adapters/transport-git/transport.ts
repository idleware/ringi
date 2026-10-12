// transport: the git store as a store type: a hub's repository is `store/.git` in the hub's directory; a signed hub's
// root key is made here (remote/keys.ts) and a published hub is replicated by bootstrap (remote/bootstrap.ts).

import path from 'node:path'
import type {Transport} from '../../core/hub/ports/store.ts'
import {GitStore} from './index.ts'
import * as Remote from './remote.ts'
import type {SigningContext} from '../../core/signing/index.ts'

type Options = {signer?: SigningContext | (() => SigningContext)}
const context = (d: {trust: string}, opt: Options) => d.trust === 'signed'
  ? typeof opt.signer === 'function' ? opt.signer() : opt.signer
  : undefined

// `home`: where this machine keeps its state; the git store keeps its keys, scratch indexes and migration backups there.
export const gitTransport = (home: string, opt: Options = {}): Transport => ({
  open: (at, d) => new GitStore(at, d, home, context(d, opt)),
  create: (at, d, genesis) => {
    const signing = context(d, opt)
    if (d.trust === 'signed') d.root = GitStore.rootFor(at, d, home, signing)
    const g = genesis(d)
    const store = GitStore.create(at, d, {home, signing}, g.files, g.text)
    if (d.trust === 'signed') d.genesis = store.contractHead()
    const custody = d.trust !== 'signed' ? null : signing ? signing.custody?.(d.name, 'operator') ?? null : path.join(home, 'keys', d.name, 'operator')
    return {store, custody}
  },
  attach: (name, url, pins) => { Remote.hubAdd({home, name, url, ...pins}) },
})
