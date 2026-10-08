// hubs: the operator's hubs on this machine: list, create, switch, add a signed replica, amend the shared contract.

import fs from 'node:fs'
import path from 'node:path'
import {DEFAULT_PROFILE, PROFILES_CAPABILITY, parseProfile} from '../domain/profiles.ts'
import {HOME, OPERATOR, config, ensureHome, setConfig} from '../home/index.ts'
import {createHub, hubNames, openHub, roomNames} from '../hub/index.ts'
import type {Hub} from '../hub/index.ts'
import {fail, strictJson, words} from '../lib/index.ts'
import {ID_RE, compose} from '../protocol/index.ts'
import * as Remote from '../store/git/remote.ts'

// The operator's terminal context picks the hub unless one is named.
export const hubOf = (name?: string): Hub => openHub(name ?? config().hub)

export type HubView = {name: string, current: boolean, store: string, trust: string, contract: string, rooms: number, remote: string | null, dir: string}
export const hubs = (): HubView[] => {
  ensureHome()
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
  createHub(name, {signed, url})
  const H = openHub(name)
  return {H, rootKey: H.signed ? path.join(HOME, 'keys', name, OPERATOR) : null,
    add: H.signed ? `ringi hub add ${name} ${H.d.store.remote ?? '<url>'} --root '${H.d.root}' --genesis ${H.d.genesis}` : null}
}
export const use = (name: string): void => {
  openHub(name)
  setConfig({hub: name, room: null})
}
// A replica of a signed hub. The root key comes from the operator, out of band: a key the hub advertises proves nothing.
export const add = (name: string, url: string, {root, genesis}: {root?: string, genesis?: string}): Hub => {
  if (!ID_RE.test(name) || !url) fail('usage: ringi hub add <name> <git url> --root <public key|file> [--genesis <sha>]')
  ensureHome()
  Remote.hubAdd({home: HOME, name, url, root, genesis})
  return openHub(name)
}
export type AmendInput = {text: string, set?: string[], authority?: string, files?: Array<{path: string, content: Buffer}>}
// A new version of the shared contract on `main`. Rooms keep their base until moved (rooms.rebase).
export const amend = (H: Hub, x: AmendInput): {version: string} => {
  const name = H.store.contractFile(H.main, 'contract.json') !== null ? 'contract.json' : 'hub.json'
  const contract = strictJson<Record<string, unknown>>(H.store.contractFile(H.main, name)!, name)
  for (const kv of x.set ?? []) {
    const [k, v] = kv.split(/=(.*)/s)
    if (!['version', 'capabilities', 'protocol', 'profile'].includes(k)) fail(`contract keys that can be set: version, capabilities, protocol, profile (not ${k})`)
    contract[k] = k === 'capabilities' ? words(v) : k === 'protocol' ? Number(v) : v
  }
  const files: Record<string, string | Buffer> = {[name]: JSON.stringify(contract, null, 2) + '\n'}
  if (x.authority) files['authority.json'] = JSON.stringify(strictJson(fs.readFileSync(x.authority, 'utf8'), x.authority), null, 2) + '\n'
  for (const f of x.files ?? []) {
    // A profile is checked before it reaches the contract.
    if (/^profiles\/[^/]+\.json$/.test(f.path)) parseProfile(f.content.toString('utf8'), f.path)
    files[f.path] = f.content
  }
  if (typeof contract.profile === 'string' && contract.profile !== DEFAULT_PROFILE && !files[`profiles/${contract.profile}.json`] && H.store.contractFile(H.main, `profiles/${contract.profile}.json`) === null) {
    fail(`the default profile ${contract.profile} is not in the hub; attach it: --attach <file>:profiles/${contract.profile}.json`)
  }
  // Profiles other than the built-in A2A rules need clients that read them: the contract says so.
  if (Object.keys(files).some(f => f.startsWith('profiles/')) || (x.set ?? []).some(kv => kv.startsWith('profile='))) {
    const caps = Array.isArray(contract.capabilities) ? contract.capabilities as string[] : []
    if (!caps.includes(PROFILES_CAPABILITY)) contract.capabilities = [...caps, PROFILES_CAPABILITY]
    files[name] = JSON.stringify(contract, null, 2) + '\n'
  }
  H.store.amendContract(OPERATOR, compose(x.text, [['To', '*'], ['Kind', 'hub']]), files)
  return {version: String(contract.version)}
}
