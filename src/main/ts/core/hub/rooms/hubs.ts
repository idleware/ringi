// hubs: a hub's descriptor beside its store, the contract it carries, and opening it.

import {hubPorts, locked} from '../ports/index.ts'
import {fail} from '../../../lib/index.ts'
import {compose} from '../protocol/index.ts'
import type {Descriptor} from '../ports/store.ts'
import {descriptorRefusal} from './compat.ts'
import {storeOf, transportOf} from './address.ts'
import {genesisFiles} from './contracts.ts'
export {storeOf, transportOf} from './address.ts'
export {checkedContract, openContract, amendContract, readProfileResource} from './contracts.ts'
import type {Hub} from './index.ts'

// A hub on this machine is a directory under `hub` with its descriptor (`hub`) in it.
const has = (name: string): boolean => hubPorts().state.list(['hub', name]).includes('hub')
export const hubNames = (): string[] => hubPorts().state.list(['hub']).filter(has)
const descriptor = (name: string, signed: boolean, url: string | undefined): Descriptor =>
  ({schema: 'ringi-hub/3', name, trust: signed ? 'signed' : 'asserted', genesis: '', store: {type: url ? storeOf(url).type : hubPorts().store}, contract: {path: 'contract', ...(url ? {remote: url} : {})}})
// A new hub: its store made, then its descriptor written; a failure in between leaves no half-made hub. `custody`: where
// a signed hub's new root key is kept.
const makeHub = (name: string, d: Descriptor): {custody: string | null} => {
  const st = hubPorts().state, t = transportOf(name, d.store.type)
  const made = t.create(st.place(['hub', name]), d, x => ({files: genesisFiles(x, t.layout), text: compose(`hub ${name}`, [['To', '*'], ['Kind', 'hub']])}))
  d.genesis = made.store.contractHead()
  const why = descriptorRefusal(d, name)
  if (why) fail(why)
  st.write(['hub', name, 'hub'], d)
  return {custody: made.custody}
}
const newHub = (name: string, signed: boolean, url?: string): Descriptor => {
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(name)) fail(`bad hub name ${name}`)
  if (hubPorts().state.list(['hub']).includes(name)) fail(`hub ${name} exists`)
  if (url && !signed) fail('--url publishes a hub; only a --signed hub may be published')
  return descriptor(name, signed, url)
}
export const createHub = (name: string, {signed = false, url}: {signed?: boolean, url?: string} = {}): {custody: string | null} => locked('hub-catalogue', () => {
  const d = newHub(name, signed, url)
  try {return makeHub(name, d)} catch (e) {
    if (!has(name)) hubPorts().state.remove(['hub', name])
    throw e
  }
})
const readDescriptor = (name: string): Descriptor => {
  const d = hubPorts().state.read<Descriptor | null>(['hub', name, 'hub'], null) ?? fail(`no hub ${name}; hubs: ${hubNames().join(', ') || 'none'}`)
  const why = descriptorRefusal(d, name)
  if (why) fail(why)
  return d
}
// Opening a catalogue never chooses a repository or requires an operator contract source.
export const openHub = (name: string, {refresh = false}: {refresh?: boolean} = {}): Hub => {
  hubPorts().state.ensure()
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(name)) fail(`bad hub name ${name}`)
  if (name === 'local' && !has(name)) createHub('local')
  const d = readDescriptor(name)
  // Descriptors are cheap local reads. Refresh has no implicit fan-out to rooms.
  void refresh
  return {name, dir: hubPorts().state.place(['hub', name]), d, signed: d.trust === 'signed'}
}
export {adoptHub} from './adoption.ts'
