// The git store, asserted (a local hub) and signed (keys on this machine, no remote), against the contract every store
// type passes (store-contract.ts).
import path from 'node:path'
import {compose} from '../../main/ts/core/hub/protocol/index.ts'
import type {Descriptor, Genesis} from '../../main/ts/core/hub/ports/store.ts'
import {gitTransport} from '../../main/ts/adapters/transport-git/transport.ts'
import {keysFile} from '../../main/ts/adapters/keys-file/index.ts'
import {storeContract} from './store-contract.ts'

const descriptor = (trust: Descriptor['trust']): Descriptor => ({schema: 'ringi-hub/2', name: 'contract', trust, store: {type: 'git', path: 'store'}})
// A signed contract names the root the transport just made (d.root).
const genesis: Genesis = d => ({text: compose('hub contract', [['To', '*'], ['Kind', 'hub']]), files: {'contract.json':
  JSON.stringify({schema: 'ringi-hub', version: '1.2', protocol: 1, trust: d.trust, ...(d.root ? {root: d.root} : {}), store: 'git/2'}) + '\n'}})

for (const trust of ['asserted', 'signed'] as const) storeContract(`git, ${trust}`, dir => {
  const home = path.join(dir, 'home'), at = path.join(dir, 'hub'), d = descriptor(trust)
  const git = gitTransport(home, {signer: () => keysFile(home)})
  const {store} = git.create(at, d, genesis)
  return {store, again: () => git.open(at, d)}
})
