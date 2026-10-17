// state-fs: the machine's state as files under one directory ($RINGI_HOME, default ~/.ringi). A key path is a path
// below it and a record is `<key>.json`, written atomically; a lock is a file under `locks/`. The directory is made on
// first use; one of another version, or anything else there, is refused. A write the sandbox denies fails with one fixed instruction (adapters/fs/write.ts).

import fs from 'node:fs'
import path from 'node:path'
import {errno, fail, strictJson} from '../../lib/index.ts'
import {guardWrite, locked as lockFile, mkdirIn, writeJsonAtomic} from '../fs/index.ts'
import {archiveState} from './archive.ts'
import type {Build, Key, LocalState} from '../../core/hub/ports/index.ts'

const HOME_VERSION = 4
// Future E8 composition; declaring it does not change the active home gate.
export const E8_HOME_VERSION = 5

// State fails closed: unreadable JSON is an error, never a silent fresh start.
const readJson = <T>(f: string, dflt: T): T => {
  let raw: string
  try { raw = fs.readFileSync(f, 'utf8') } catch (e) {
    if (errno(e) === 'ENOENT') return dflt
    throw e
  }
  try { JSON.parse(raw) } catch (e) { return fail(`${f} is not valid JSON (${(e as Error).message}); refusing to continue with lost state`) }
  // A field written twice hides a value (a second root pin, say): refused, not read as the last one.
  return strictJson<T>(raw, f)
}

// A key's segment as a name in its directory: nothing that leaves it or names it twice.
const segment = (s: string): string =>
  !s || s === '.' || s === '..' || /[/\\\0]/.test(s) ? fail(`bad state key segment ${JSON.stringify(s)}`) : s

type StateOptions = {root: string, build: Build}
const ensureHome = (state: LocalState, build: Build, version: number): void => {
  const root = state.root, marker = path.join(root, 'home.json')
  if (fs.existsSync(marker)) {
    const v = readJson<{version?: number}>(marker, {}).version
    if (v !== version) fail(`${root} is a ringi home of version ${v}; this ringi ${build.version} needs version ${version}. Move it away (the ringi that made it still reads it with RINGI_HOME pointing there) or set RINGI_HOME to a new directory; ringi does not migrate`)
    return
  }
  if (fs.existsSync(root) && fs.readdirSync(root).length) fail(`${root} exists and is not a ringi home (no home.json); move it away or set RINGI_HOME`)
  mkdirIn(root, root)
  state.write(['home'], {version})
}
const makeState = ({root, build}: StateOptions, version: number): LocalState => {
  const guard = <T>(fn: () => T): T => guardWrite(root, fn)
  const dir = (key: Key) => path.join(root, ...key.map(segment))
  const file = (key: Key) => `${dir(key)}.json`
  const state: LocalState = {
    root,
    ensure: () => ensureHome(state, build, version),
    locked: (name, fn) => {
      if (version === E8_HOME_VERSION) segment(name)
      state.ensure()
      return guard(() => lockFile(path.join(state.place(['locks']), `${name}.lock`), fn))
    },
    read: (key, dflt) => readJson(file(key), dflt),
    write: (key, value) => guard(() => {
      mkdirIn(root, path.dirname(file(key)))
      writeJsonAtomic(file(key), value)
    }),
    remove: key => guard(() => {
      fs.rmSync(file(key), {force: true})
      fs.rmSync(dir(key), {recursive: true, force: true})
    }),
    list: key => {
      let names: string[] = []
      try { names = fs.readdirSync(dir(key)) } catch (e) {
        if (version === E8_HOME_VERSION && errno(e) !== 'ENOENT') throw e
      }
      return [...new Set(names.map(n => n.replace(/\.json$/, '')))].sort()
    },
    place: key => {
      mkdirIn(root, dir(key))
      return dir(key)
    },
  }
  if (version === E8_HOME_VERSION) state.archive = request => { state.ensure(); return archiveState(root, request) }
  return state
}
// Separate factories: current composition still calls stateFs and needs home/4. No reinterpretation or migration.
export const stateFs = (options: StateOptions): LocalState => makeState(options, HOME_VERSION)
export const stateFsV5 = (options: StateOptions): LocalState => makeState(options, E8_HOME_VERSION)
