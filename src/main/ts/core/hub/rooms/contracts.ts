// The operator's explicit contract source, distinct from frozen room copies.
import fs from 'node:fs'
import path from 'node:path'
import {DEFAULT_PROFILE, PROFILES_CAPABILITY} from '../work/index.ts'
import {ROOMS_CAPABILITY} from '../capabilities.ts'
import {hubPorts, locked} from '../ports/index.ts'
import {fail, strictJson} from '../../../lib/index.ts'
import type {Descriptor, Rev, Store} from '../ports/store.ts'
import {contractAt, contractRefusal, layoutRefusal} from './compat.ts'
import {PROTOCOL_MAJOR} from './index.ts'
import type {Contract, Hub} from './index.ts'
import {transportOf} from './address.ts'
const HUB_MD = `# ringi hub

The shared contract of a ringi hub (docs/spec/hub-2.md): contract.json (schema, version, protocol, trust, capabilities, the
default profile) and profiles/ (what a piece of work is in a room: its states, and who may move it). Use \`ringi\`; never edit by hand.
`
export const readProfileResource = (name: string): string => fs.readFileSync(path.join(hubPorts().build.resources, 'profiles', `${name}.json`), 'utf8')
// A new hub: local (asserted senders), or signed, with the operator's root key generated on this machine and pinned.
// The files of a new hub's first contract.
export const genesisFiles = (d: Descriptor, layout: string): Record<string, string> => {
  // A git/4 hub requires rooms/1, so a reader that cannot remove members refuses it rather than misreads it.
  const capabilities = layout === 'git/4' ? [PROFILES_CAPABILITY, ROOMS_CAPABILITY] : [PROFILES_CAPABILITY]
  const contract = {schema: 'ringi-hub', version: '2.0', protocol: PROTOCOL_MAJOR, trust: d.trust, store: layout, capabilities, profile: DEFAULT_PROFILE, ...(d.root ? {root: d.root} : {})}
  return {
    'contract.json': JSON.stringify(contract, null, 2) + '\n',
    'HUB.md': HUB_MD,
    [`profiles/${DEFAULT_PROFILE}.json`]: readProfileResource(DEFAULT_PROFILE),
  }
}
export const checkedContract = (H: Hub, store: Store): {main: Rev, contract: Contract} => {
  const main = store.contractHead()
  if (!store.extends(H.d.genesis, main)) fail(`hub ${H.name}: main does not descend from its pinned genesis`)
  const contract = contractAt(store, H.name, main)
  const t = transportOf(H.name, store.type)
  const why = layoutRefusal(H.name, contract.store, t.layout)
  if (why) fail(why)
  if (contract.trust !== H.d.trust || (H.signed && contract.root !== H.d.root)) fail(`hub ${H.name}: contract changes its pinned trust or root`)
  return {main, contract}
}
// A git/4 hub's contract: its exact layout, the rooms/1 it requires, and the trust and root it pinned.
export const checkedContractV4 = (H: Hub, store: Store, layout = 'git/4'): {main: Rev, contract: Contract} => {
  const main = store.contractHead()
  if (!store.extends(H.d.genesis, main)) fail(`hub ${H.name}: main does not descend from its pinned genesis`)
  const contract = contractAt(store, H.name, main)
  if (contract.store !== layout) fail(`hub ${H.name}: its contract lays rooms out as ${contract.store}, not ${layout}`)
  if (!(contract.capabilities ?? []).includes(ROOMS_CAPABILITY)) fail(`hub ${H.name}: its contract does not require ${ROOMS_CAPABILITY}`)
  if (contract.trust !== H.d.trust || (H.signed && contract.root !== H.d.root)) fail(`hub ${H.name}: contract changes its pinned trust or root`)
  return {main, contract}
}
export const openContract = (H: Hub, {refresh = false}: {refresh?: boolean} = {}): {store: Store, main: Rev, contract: Contract} => {
  if (!H.d.contract) fail(`hub ${H.name}: no operator contract source; open a named room instead`)
  const store = transportOf(H.name, H.d.store.type).open(H.dir, H.d)
  // Each handle syncs once; refreshing explicitly reads the source again, never an arbitrary room.
  void refresh
  store.sync()
  return {store, ...checkedContract(H, store)}
}
export const amendContract = (H: Hub, who: string, text: string, files: Record<string, string | Buffer>): Rev =>
  locked(`hub-${H.name}`, () => {
    const {store} = openContract(H, {refresh: true})
    if (files['contract.json'] !== undefined) {
      const candidate = strictJson<Contract>(files['contract.json'].toString(), `hub ${H.name}: proposed contract`)
      const why = contractRefusal(candidate, H.name) ?? layoutRefusal(H.name, candidate.store, transportOf(H.name, H.d.store.type).layout)
      if (why) fail(why)
      if (candidate.trust !== H.d.trust || candidate.root !== H.d.root) fail('contract amendment must retain the pinned trust and root')
    }
    const rev = store.amendContract(who, text, files)
    checkedContract(H, store)
    return rev
  })
