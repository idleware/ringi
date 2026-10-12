// The git store, asserted (a local hub), against the contract every store type passes (store-contract.ts).
import path from 'node:path'
import {compose} from '../../main/ts/core/hub/protocol/index.ts'
import type {Descriptor} from '../../main/ts/core/hub/ports/store.ts'
import {gitTransport} from '../../main/ts/adapters/transport-git/transport.ts'
import {storeContract} from './store-contract.ts'

const descriptor = (): Descriptor => ({schema: 'ringi-hub/2', name: 'contract', trust: 'asserted', store: {type: 'git', path: 'store'}})
const genesis = () => ({files: {'contract.json': '{"schema":"ringi-hub","version":"1.2","protocol":1,"trust":"asserted","store":"git/2"}\n'}, text: compose('hub contract', [['To', '*'], ['Kind', 'hub']])})

storeContract('git, asserted', dir => {
  const home = path.join(dir, 'home'), at = path.join(dir, 'hub')
  const git = gitTransport(home)
  const {store} = git.create(at, descriptor(), genesis)
  return {store, again: () => git.open(at, descriptor())}
})
