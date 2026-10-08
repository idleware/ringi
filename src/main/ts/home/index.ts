// home: where ringi keeps its state on this machine. $RINGI_HOME holds hubs (each a descriptor and a store),
// reader state, session records and locks. Reading state fails closed; a write the sandbox denies fails with one
// fixed instruction.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {errno, fail, guardWrite, locked as lockFile, mkdirIn, note, writeJsonAtomic} from '../lib/index.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// This file sits in src/main/ts/home (source) or target/esm/home (build): three levels below the package root.
export const ROOT = path.resolve(HERE, '..', '..', '..')
export const RESOURCES = path.join(ROOT, 'src', 'main', 'resources')
export const VERSION: string = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
export const HOME = path.resolve(process.env.RINGI_HOME || path.join(os.homedir(), '.ringi'))
export const HOME_VERSION = 3
export const OPERATOR = 'operator'

// --- writing safely ---

export const guard = <T>(fn: () => T): T => guardWrite(HOME, fn)
export const mkdir = (d: string): void => mkdirIn(HOME, d)
export const writeJson = (f: string, v: unknown): void => guard(() => {
  mkdir(path.dirname(f))
  writeJsonAtomic(f, v)
})
// State fails closed: unreadable JSON is an error, never a silent fresh start.
export const readJson = <T>(f: string, dflt: T): T => {
  let raw: string
  try { raw = fs.readFileSync(f, 'utf8') } catch (e) {
    if (errno(e) === 'ENOENT') return dflt
    throw e
  }
  try { return JSON.parse(raw) as T } catch (e) { return fail(`${f} is not valid JSON (${(e as Error).message}); refusing to continue with lost state`) }
}

// --- the home ---

export const hubsDir = (): string => path.join(HOME, 'hub')
export const hubHome = (name: string): string => path.join(hubsDir(), name)
// The home is created on first use; anything else at that path is refused. A home of the previous layout (each hub a
// bare repository `hub/<name>.git` with its settings in git config) is moved into descriptor and store.
export const ensureHome = (): void => {
  const marker = path.join(HOME, 'home.json')
  if (fs.existsSync(marker)) {
    const h = readJson<{version?: number}>(marker, {})
    if (h.version === 2) return migrate2(marker)
    if (h.version !== HOME_VERSION) fail(`${HOME} is a ringi home of version ${h.version}; this ringi ${VERSION} needs version ${HOME_VERSION}`)
    return
  }
  if (fs.existsSync(HOME) && fs.readdirSync(HOME).length) fail(`${HOME} exists and is not a ringi home (no home.json); move it away or set RINGI_HOME`)
  mkdir(HOME)
  writeJson(marker, {version: HOME_VERSION})
}
const migrate2 = (marker: string) => {
  for (const f of fs.existsSync(hubsDir()) ? fs.readdirSync(hubsDir()).filter(f => f.endsWith('.git')) : []) {
    const name = f.slice(0, -4)
    const old = path.join(hubsDir(), f)
    const cfg = (k: string) => String(spawnSync('git', ['--git-dir', old, 'config', '--get', k], {encoding: 'utf8'}).stdout ?? '').trim()
    const signed = cfg('ringi.type') === 'remote'
    const descriptor = {schema: 'ringi-hub/2', name, trust: signed ? 'signed' : 'asserted',
      ...(signed ? {root: cfg('ringi.rootKey') || undefined, genesis: cfg('ringi.genesis') || undefined} : {}),
      store: {type: 'git', path: 'store', ...(cfg('remote.origin.url') ? {remote: cfg('remote.origin.url')} : {})}}
    mkdir(path.join(hubHome(name), 'store'))
    guard(() => fs.renameSync(old, path.join(hubHome(name), 'store', '.git')))
    writeJson(path.join(hubHome(name), 'hub.json'), descriptor)
    note(`moved hub ${name} to ${hubHome(name)} (descriptor hub.json, store/.git)`)
  }
  writeJson(marker, {version: HOME_VERSION})
}
export const locked = <T>(name: string, fn: () => T): T => {
  ensureHome()
  const dir = path.join(HOME, 'locks')
  mkdir(dir)
  return guard(() => lockFile(path.join(dir, `${name}.lock`), fn))
}
export type Config = {hub: string, room: string | null}
export const configFile = (): string => path.join(HOME, 'config.json')
export const config = (): Config => ({hub: 'local', room: null, ...readJson<Partial<Config>>(configFile(), {})})
export const setConfig = (patch: Partial<Config>): void => writeJson(configFile(), {...config(), ...patch})
