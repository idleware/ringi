// hubs: the operator's hubs on this machine: list, create, switch, add a signed replica, amend the shared contract.

import fs from 'node:fs'
import {DEFAULT_PROFILE, PROFILES_CAPABILITY, parseProfile} from '../work/index.ts'
import {OPERATOR, config, createHub, hubNames, openHub, roomNames, setConfig, transportOf} from '../rooms/index.ts'
import {hubPorts} from '../ports/index.ts'
import type {Hub} from '../rooms/index.ts'
import {fail, strictJson, words} from '../../../lib/index.ts'
import {ID_RE, compose} from '../protocol/index.ts'

// The operator's terminal context picks the hub unless one is named.
export const hubOf = (name?: string): Hub => openHub(name ?? config().hub)

export type HubView = {name: string, current: boolean, store: string, trust: string, contract: string, rooms: number, remote: string | null, dir: string}
export const hubs = (): HubView[] => {
  hubPorts().state.ensure()
  if (!hubNames().length) openHub('local')
  const cur = config().hub
  return hubNames().map(n => {
    const H = openHub(n)
    return {name: H.name, current: H.name === cur, store: H.d.store.type, trust: H.contract.trust, contract: H.contract.version,
      rooms: roomNames(H).length, remote: H.d.store.remote ?? null, dir: H.dir}
  })
}
// A new hub; a signed one makes its root key here and returns what other machines need to pin it.
export const create = (name: string, {signed = false, url}: {signed?: boolean, url?: string} = {}): {H: Hub, rootKey: string | null, add: string | null} => {
  if (!ID_RE.test(name)) fail('usage: ringi hub create <name> [--signed [--url <git url>]]')
  const {custody} = createHub(name, {signed, url})
  const H = openHub(name)
  return {H, rootKey: custody,
    add: H.signed ? `ringi hub add ${name} ${H.d.store.remote ?? '<url>'} --root '${H.d.root}' --genesis ${H.d.genesis}` : null}
}
export const use = (name: string): void => {
  openHub(name)
  setConfig({hub: name, room: null})
}
// A replica of a signed hub. The root key comes from the operator, out of band: a key the hub advertises proves nothing.
export const add = (name: string, url: string, {root, genesis}: {root?: string, genesis?: string}): Hub => {
  if (!ID_RE.test(name) || !url) fail('usage: ringi hub add <name> <git url> --root <public key|file> [--genesis <sha>]')
  hubPorts().state.ensure()
  const t = transportOf(name, hubPorts().store)
  if (!t.attach) return fail(`a ${hubPorts().store} store cannot replicate a published hub`)
  t.attach(name, url, {root, genesis})
  return openHub(name)
}
export type AmendInput = {text: string, set?: string[], authority?: string, files?: Array<{path: string, content: Buffer}>}
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
  if (x.authority) files['authority.json'] = json(strictJson(fs.readFileSync(x.authority, 'utf8'), x.authority))
  for (const f of x.files ?? []) {
    if (/^profiles\/[^/]+\.json$/.test(f.path)) parseProfile(f.content.toString('utf8'), f.path)
    files[f.path] = f.content
  }
  return files
}
// The default profile must be built in, or in the hub after this amendment.
const checkDefault = (H: Hub, contract: Contract, files: Record<string, unknown>): void => {
  const p = contract.profile
  if (typeof p !== 'string' || p === DEFAULT_PROFILE || files[`profiles/${p}.json`]) return
  if (H.store.contractFile(H.main, `profiles/${p}.json`) === null) fail(`the default profile ${p} is not in the hub; attach it: --attach <file>:profiles/${p}.json`)
}
// Profiles other than the built-in A2A rules need clients that read them: the contract says so.
const needsProfiles = (contract: Contract, files: Record<string, unknown>, set: string[]): void => {
  if (!Object.keys(files).some(f => f.startsWith('profiles/')) && !set.some(kv => kv.startsWith('profile='))) return
  const caps = Array.isArray(contract.capabilities) ? contract.capabilities as string[] : []
  if (!caps.includes(PROFILES_CAPABILITY)) contract.capabilities = [...caps, PROFILES_CAPABILITY]
}
// A new version of the shared contract on `main`. Rooms keep their base until moved (rooms.rebase).
export const amend = (H: Hub, x: AmendInput): {version: string} => {
  const name = H.store.contractFile(H.main, 'contract.json') !== null ? 'contract.json' : 'hub.json'
  const contract = strictJson<Contract>(H.store.contractFile(H.main, name)!, name)
  setKeys(contract, x.set ?? [])
  const files = extraFiles(x)
  checkDefault(H, contract, files)
  needsProfiles(contract, files, x.set ?? [])
  H.store.amendContract(OPERATOR, compose(x.text, [['To', '*'], ['Kind', 'hub']]), {[name]: json(contract), ...files})
  return {version: String(contract.version)}
}
