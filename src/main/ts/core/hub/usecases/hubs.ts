// hubs: the operator's hubs on this machine: list, create, amend the shared contract.

import {DEFAULT_PROFILE, PROFILES_CAPABILITY, parseProfile} from '../work/index.ts'
import {OPERATOR, amendContract, createHub, hubNames, openContract, openHub, roomNames} from '../rooms/index.ts'
import {hubPorts} from '../ports/index.ts'
import {accessOf, spaceFor} from './access.ts'
import type {Store} from '../ports/store.ts'
import type {Hub} from '../rooms/index.ts'
import {fail, strictJson, withoutCredentials, words} from '../../../lib/index.ts'
import {ID_RE, compose} from '../protocol/index.ts'

// A remote as shown and handed to other machines: never with a password or token in it; each machine has its own.
const shown = (url: string | undefined): string | null => url ? withoutCredentials(url) : null
// The named hub, or `local`.
export const hubOf = (name?: string): Hub => openHub(name ?? 'local')

// `contract`: the version of the contract this machine holds the source of; an agent's machine holds only rooms.
export type HubView = {name: string, store: string, trust: string, contract: string | null, rooms: number, remote: string | null, dir: string}
export const hubs = (): HubView[] => {
  hubPorts().state.ensure()
  if (!hubNames().length) openHub('local')
  return hubNames().map(n => {
    const H = openHub(n)
    return {name: H.name, store: H.d.store.type, trust: H.d.trust, contract: H.d.contract ? openContract(H).contract.version : null,
      rooms: roomNames(H).length, remote: shown(H.d.contract?.remote), dir: H.dir}
  })
}
export type HubInput = {signed?: boolean, url?: string, forge?: string, authFile?: string, hostKeyFile?: string}
// A new hub; a signed one makes its root key here. Agents elsewhere never attach the hub: each joins its room. With
// `forge`, its rooms are made in that space, checked before the hub is.
export const create = async (name: string, {signed = false, url, forge, authFile, hostKeyFile}: HubInput = {}) => {
  if (!ID_RE.test(name)) fail('usage: ringi hub create <name> [--signed [--url <address>] [--forge <space> --auth-file <file> --host-key-file <file>]]')
  const made = await spaceFor({signed, url, forge, authFile, hostKeyFile})
  const {custody} = createHub(name, {signed, url})
  if (made) hubPorts().state.write(['hub', name, 'hub'], {...openHub(name).d, access: made.access})
  const H = openHub(name)
  // The root pushes to the forge as the operator's account: its key goes there now, and again before each room if missing.
  if (made) await accessOf(H)!.ownKey(H.d.root!).catch((e: Error) => fail(`hub ${name} is made here, its root key not yet on the forge: ${e.message}`))
  return {H, rootKey: custody, remote: shown(H.d.contract?.remote), space: made && {address: shown(made.access.address), principal: made.principal, version: made.version}}
}
export type AmendInput = {text: string, set?: string[], files?: Array<{path: string, content: Buffer}>}
type Contract = Record<string, unknown>
const SETTABLE = ['version', 'capabilities', 'protocol', 'profile']
const json = (x: unknown): string => JSON.stringify(x, null, 2) + '\n'
// `key=value` pairs on the contract: capabilities are words, protocol a number, the rest strings.
const setKeys = (contract: Contract, set: string[]): void => {
  for (const kv of set) {
    const [k, v] = kv.split(/=(.*)/s)
    if (!SETTABLE.includes(k)) fail(`contract keys that can be set: ${SETTABLE.join(', ')} (not ${k})`)
    contract[k] = k === 'capabilities' ? words(v) : k === 'protocol' ? Number(v) : v
  }
}
// The files the amendment brings besides the contract; a profile is checked before it reaches the contract.
const extraFiles = (x: AmendInput): Record<string, string | Buffer> => {
  const files: Record<string, string | Buffer> = {}
  for (const f of x.files ?? []) {
    if (/^profiles\/[^/]+\.json$/.test(f.path)) parseProfile(f.content.toString('utf8'), f.path)
    files[f.path] = f.content
  }
  return files
}
// The default profile must be built in, or in the hub after this amendment.
const checkDefault = (source: {store: Store, main: string}, contract: Contract, files: Record<string, unknown>): void => {
  const p = contract.profile
  if (typeof p !== 'string' || p === DEFAULT_PROFILE || files[`profiles/${p}.json`]) return
  if (source.store.contractFile(source.main, `profiles/${p}.json`) === null) fail(`the default profile ${p} is not in the hub; attach it: --attach <file>:profiles/${p}.json`)
}
// Profiles other than the built-in A2A rules need clients that read them: the contract says so.
const needsProfiles = (contract: Contract, files: Record<string, unknown>, set: string[]): void => {
  if (!Object.keys(files).some(f => f.startsWith('profiles/')) && !set.some(kv => kv.startsWith('profile='))) return
  const caps = Array.isArray(contract.capabilities) ? contract.capabilities as string[] : []
  if (!caps.includes(PROFILES_CAPABILITY)) contract.capabilities = [...caps, PROFILES_CAPABILITY]
}
// A new version of the shared contract on `main`. Rooms made from then on follow it; existing ones keep theirs.
export const amend = (H: Hub, x: AmendInput): {version: string} => {
  const name = 'contract.json', source = openContract(H)
  const contract = strictJson<Contract>(source.store.contractFile(source.main, name)!, name)
  setKeys(contract, x.set ?? [])
  const files = extraFiles(x)
  checkDefault(source, contract, files)
  needsProfiles(contract, files, x.set ?? [])
  amendContract(H, OPERATOR, compose(x.text, [['To', '*'], ['Kind', 'hub']]), {[name]: json(contract), ...files})
  return {version: String(contract.version)}
}
