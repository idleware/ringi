// The git store, asserted (a local hub) and signed (keys on this machine, no remote), against the contract every store
// type passes (store-contract.ts).
import path from 'node:path'
import {compose} from '../../main/ts/core/hub/protocol/index.ts'
import type {Descriptor, Genesis, RoomEndpoint} from '../../main/ts/core/hub/ports/store.ts'
import {gitTransport} from '../../main/ts/adapters/store-git/transport.ts'
import {keysFile} from '../../main/ts/adapters/keys-file/index.ts'
import {storeContract} from './store-contract.ts'

const descriptor = (trust: Descriptor['trust']): Descriptor => ({schema: 'ringi-hub/3', name: 'contract', trust, genesis: '', store: {type: 'git'}, contract: {path: 'contract'}})
// A signed contract names the root the transport just made (d.root).
const genesis: Genesis = d => ({text: compose('hub contract', [['To', '*'], ['Kind', 'hub']]), files: {'contract.json':
  JSON.stringify({schema: 'ringi-hub', version: '2.0', protocol: 1, trust: d.trust, ...(d.root ? {root: d.root} : {}), store: 'git/3'}) + '\n'}})

for (const trust of ['asserted', 'signed'] as const) storeContract(`git, ${trust}`, dir => {
  const home = path.join(dir, 'home'), at = path.join(dir, 'hub'), d = descriptor(trust)
  const git = gitTransport(home, {signer: () => keysFile(home)})
  const source = git.create(at, d, genesis).store
  const endpoint: RoomEndpoint = {schema: 'ringi-room/1', name: 'r', hubGenesis: d.genesis, genesis: '', store: {path: 'store'}}
  const roomDir = path.join(at, 'rooms', 'r')
  const store = git.fork(roomDir, d, source, endpoint)
  return {store, again: () => git.open(roomDir, d, endpoint)}
})
