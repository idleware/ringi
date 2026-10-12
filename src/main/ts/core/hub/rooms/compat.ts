// compat: the gates a hub passes before ringi reads it, all in one place: this machine's descriptor of it, its
// contract's schema and major version, the protocol major, the capabilities its rooms need, and how its store lays out
// what it keeps. The home has its own gate (adapters/state-fs). Each gate fails closed and says what to do. ringi migrates nothing: a hub it cannot read stays as it is, and the operator makes a new hub
// beside it, or a new root branch on a forge (docs/ARCHITECTURE.md, Evolution).

import type * as D from '../decisions/index.ts'
import {unenforceable} from '../capabilities.ts'
import {hubPorts} from '../ports/index.ts'
import type {Descriptor, Rev, Store} from '../ports/store.ts'
import {fail, short, strictJson} from '../../../lib/index.ts'
import {HUB_MAJOR, PROTOCOL_MAJOR} from './index.ts'
import type {Contract} from './index.ts'

const version = () => hubPorts().build.version
// What to do with a hub this ringi cannot read.
const beside = 'make a new hub beside it (ringi hub create <name>), or a new root branch on a forge; ringi does not migrate'
const newer = (major: number, mine: number) => major > mine ? 'upgrade ringi' : beside

// Why this ringi cannot read the hub's descriptor (hub.json), or nothing.
const knownSchema = (d: Descriptor, name: string): boolean => d.schema === 'ringi-hub/2' && d.name === name
const knownStore = (d: Descriptor): boolean => ['signed', 'asserted'].includes(d.trust) && !!d.store?.type && !!d.store.path
export const descriptorRefusal = (d: Descriptor, name: string): string | null =>
  knownSchema(d, name) && knownStore(d) ? null : `hub ${name}: its descriptor is not one this ringi ${version()} reads; ${beside}`
// Why this ringi cannot read the contract, or nothing.
const refusal = (c: Contract, name: string): string | null => {
  if (c.schema !== 'ringi-hub') return `hub ${name} declares schema ${String(c.schema)}, not ringi-hub`
  const major = Number(String(c.version).split('.')[0])
  if (major !== HUB_MAJOR) return `hub ${name} follows contract version ${c.version}; this ringi ${version()} supports ${HUB_MAJOR}.x: ${newer(major, HUB_MAJOR)}`
  if (c.protocol !== PROTOCOL_MAJOR) return `hub ${name} speaks protocol ${String(c.protocol)}; this ringi ${version()} speaks ${PROTOCOL_MAJOR}: ${newer(Number(c.protocol), PROTOCOL_MAJOR)}`
  const why = unenforceable(c.capabilities ?? [])
  return why && `hub ${name} ${why}, which this ringi ${version()} cannot enforce. Upgrade ringi`
}
// The contract at `rev`, once it passes every gate.
export const contractAt = (store: Store, name: string, rev: Rev): Contract => {
  const text = store.contractFile(rev, 'contract.json') ?? fail(`hub ${name} has no contract at ${short(rev)}`)
  const c = strictJson<Contract>(text, `hub ${name}: contract`)
  const why = refusal(c, name)
  if (why) fail(why)
  const a = store.contractFile(rev, 'authority.json')
  return {...c, authority: a === null ? {} : strictJson<D.Authority>(a, `hub ${name}: authority.json at ${short(rev)}`)}
}
// Why this ringi cannot read the hub's store as it is laid out (`shown`: what its contract names, or what its store
// type finds there when the contract names nothing), or nothing; `reads` is what the store type reads.
export const layoutRefusal = (name: string, shown: string, reads: string): string | null =>
  shown === reads ? null : `hub ${name} keeps its store as ${shown}; this ringi ${version()} reads ${reads}: upgrade ringi if the hub is newer, or ${beside}`
