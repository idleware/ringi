// hubs: a hub's descriptor beside its store, the contract it carries, and opening it.

import fs from 'node:fs'
import path from 'node:path'
import * as D from '../decisions/index.ts'
import {unenforceable} from '../capabilities.ts'
import {DEFAULT_PROFILE, PROFILES_CAPABILITY} from '../work/index.ts'
import {hubPorts} from '../ports/index.ts'
import {fail, short, strictJson} from '../../../lib/index.ts'
import {compose} from '../protocol/index.ts'
import type {Descriptor, Rev, Store, Transport} from '../ports/store.ts'
import {HUB_MAJOR} from './index.ts'
import type {Contract, Hub} from './index.ts'

// A hub on this machine is a directory under `hub` with its descriptor (`hub`) in it.
const has = (name: string): boolean => hubPorts().state.list(['hub', name]).includes('hub')
export const hubNames = (): string[] => hubPorts().state.list(['hub']).filter(has)
const VERSION = () => hubPorts().build.version
const HUB_MD = `# ringi hub

The shared contract of a ringi hub (docs/spec/hub-1.md): contract.json (schema, version, protocol, trust, capabilities, the
default profile), authority.json (who may decide what, up to which budget; the root, \`operator\`, always may) and
profiles/ (what a piece of work is in a room: its states, and who may move it). Use \`ringi\`; never edit by hand.
`
export const readProfileResource = (name: string): string => fs.readFileSync(path.join(hubPorts().build.resources, 'profiles', `${name}.json`), 'utf8')
// A new hub: local (asserted senders), or signed, with the operator's root key generated on this machine and pinned.
// The files of a new hub's first contract.
const genesisFiles = (d: Descriptor): Record<string, string> => {
  const contract = {schema: 'ringi-hub', version: '1.1', protocol: 1, trust: d.trust, capabilities: [D.CAPABILITY, PROFILES_CAPABILITY], profile: DEFAULT_PROFILE, ...(d.root ? {root: d.root} : {})}
  return {
    'contract.json': JSON.stringify(contract, null, 2) + '\n',
    'authority.json': JSON.stringify({decide: {}}, null, 2) + '\n',
    'HUB.md': HUB_MD,
    [`profiles/${DEFAULT_PROFILE}.json`]: readProfileResource(DEFAULT_PROFILE),
  }
}
const descriptor = (name: string, signed: boolean, url: string | undefined): Descriptor =>
  ({schema: 'ringi-hub/2', name, trust: signed ? 'signed' : 'asserted', store: {type: hubPorts().store, path: 'store', ...(url ? {remote: url} : {})}})
// The store type a descriptor names, as this build registers it.
export const transportOf = (name: string, type: string): Transport => {
  const t = hubPorts().transports
  return t[type] ?? fail(`hub ${name} uses a ${type} store; this ringi ${VERSION()} knows ${Object.keys(t).join(', ')}`)
}
// A new hub: its store made, then its descriptor written; a failure in between leaves no half-made hub. `custody`: where
// a signed hub's new root key is kept.
export const createHub = (name: string, {signed = false, url}: {signed?: boolean, url?: string} = {}): {custody: string | null} => {
  const st = hubPorts().state
  st.ensure()
  if (st.list(['hub']).includes(name)) fail(`hub ${name} exists`)
  if (url && !signed) fail('--url publishes a hub; only a --signed hub may be published')
  const d = descriptor(name, signed, url)
  try {
    const made = transportOf(name, d.store.type).create(st.place(['hub', name]), d, x => ({files: genesisFiles(x), text: compose(`hub ${name}`, [['To', '*'], ['Kind', 'hub']])}))
    st.write(['hub', name, 'hub'], d)
    return {custody: made.custody}
  } catch (e) {
    if (!has(name)) st.remove(['hub', name])
    throw e
  }
}
const knownSchema = (d: Descriptor, name: string): boolean => d.schema === 'ringi-hub/2' && d.name === name
const knownStore = (d: Descriptor): boolean => ['signed', 'asserted'].includes(d.trust) && !!d.store?.type && !!d.store.path
export const readDescriptor = (name: string): Descriptor => {
  const d = hubPorts().state.read<Descriptor | null>(['hub', name, 'hub'], null) ?? fail(`no hub ${name}; hubs: ${hubNames().join(', ') || 'none'}`)
  if (!(knownSchema(d, name) && knownStore(d))) fail(`hub ${name}: its descriptor is not one this ringi ${VERSION()} reads`)
  return d
}
// The contract a tool must understand before it touches a hub or a room: known schema, major and capabilities.
export const contractAt = (store: Store, name: string, rev: Rev): Contract => {
  const text = store.contractFile(rev, 'contract.json') ?? store.contractFile(rev, 'hub.json') ?? fail(`hub ${name} has no contract at ${short(rev)}`)
  const c = strictJson<Contract>(text, `hub ${name}: contract`)
  if (c.schema !== 'ringi-hub') fail(`hub ${name} declares schema ${String(c.schema)}, not ringi-hub`)
  const major = Number(String(c.version).split('.')[0])
  if (major !== HUB_MAJOR) fail(`hub ${name} follows contract version ${c.version}; this ringi ${VERSION()} supports ${HUB_MAJOR}.x. Upgrade ringi`)
  const why = unenforceable(c.capabilities ?? [])
  if (why) fail(`hub ${name} ${why}, which this ringi ${VERSION()} cannot enforce. Upgrade ringi`)
  const a = store.contractFile(rev, 'authority.json')
  return {...c, authority: a === null ? {} : strictJson<D.Authority>(a, `hub ${name}: authority.json at ${short(rev)}`)}
}
// A hub is opened once per process; its store syncs then (a signed store fetches and verifies), and again on refresh.
const opened = new Map<string, Hub>()
export const openHub = (name: string, {refresh = false}: {refresh?: boolean} = {}): Hub => {
  hubPorts().state.ensure()
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(name)) fail(`bad hub name ${name}`)
  if (opened.has(name) && !refresh) return opened.get(name)!
  if (name === 'local' && !has(name)) createHub('local')
  const d = readDescriptor(name)
  const dir = hubPorts().state.place(['hub', name])
  const store = transportOf(name, d.store.type).open(dir, d)
  store.sync()
  const main = store.contractHead()
  const H: Hub = {name, dir, d, store, main, contract: contractAt(store, name, main), signed: d.trust === 'signed'}
  opened.set(name, H)
  return H
}
