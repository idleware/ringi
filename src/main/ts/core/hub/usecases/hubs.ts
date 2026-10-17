// hubs: the hubs this machine keeps rooms of, and the shared contract each carries: `local` for local rooms, and one
// per space, made with its first room (access.ts). Rooms name no hub: an address says where a room is.

import {DEFAULT_PROFILE, PROFILES_CAPABILITY, parseProfile} from '../work/index.ts'
import {OPERATOR, amendContract, hubNames, openContract, openHub} from '../rooms/index.ts'
import {hubPorts} from '../ports/index.ts'
import {roomCatalogue} from '../rooms/room-catalogue.ts'
import type {Store} from '../ports/store.ts'
import type {Hub} from '../rooms/index.ts'
import {fail, strictJson, words} from '../../../lib/index.ts'
import {compose} from '../protocol/index.ts'

// `contract`: the version of the contract this machine holds the source of; an agent's machine holds only rooms.
// `space`: where its rooms are made, for a space's hub.
export type HubView = {name: string, trust: string, contract: string | null, rooms: number, space: string | null, dir: string}
export const hubs = (): HubView[] => {
  hubPorts().state.ensure()
  if (!hubNames().length) openHub('local')
  const registered = roomCatalogue(hubPorts().state).all().filter(r => r.phase === 'active')
  return hubNames().map(n => {
    const H = openHub(n)
    return {name: H.name, trust: H.d.trust, contract: H.d.contract ? openContract(H).contract.version : null,
      rooms: registered.filter(r => r.owner.name === H.name).length, space: H.d.access?.address ?? null, dir: H.dir}
  })
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
