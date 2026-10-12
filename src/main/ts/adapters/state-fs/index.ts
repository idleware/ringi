// state-fs: the machine's state as files under one directory ($RINGI_HOME, default ~/.ringi). A key path is a path
// below it and a record is `<key>.json`, written atomically, unless composition keeps an older file name for it; a lock
// is a file under `locks/`. The directory is made on
// first use; one of an older layout is migrated in place by the step composition gives for its version; anything else
// there is refused. A write the sandbox denies fails with one fixed instruction (adapters/fs/write.ts).

import fs from 'node:fs'
import path from 'node:path'
import {errno, fail, strictJson} from '../../lib/index.ts'
import {guardWrite, locked as lockFile, mkdirIn, writeJsonAtomic} from '../fs/index.ts'
import type {Build, Key, LocalState} from '../../core/hub/ports/index.ts'

const HOME_VERSION = 3
// A step that moves a home of an older version to the next one; it gets the state to write through.
export type Migration = (state: LocalState) => void

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

export const stateFs = ({root, build, migrations = {}, files = {}}: {root: string, build: Build, migrations?: Record<number, Migration>,
  files?: Record<string, string>}): LocalState => {
  const guard = <T>(fn: () => T): T => guardWrite(root, fn)
  const dir = (key: Key) => path.join(root, ...key.map(segment))
  const file = (key: Key) => files[key.join('/')] ? path.join(root, files[key.join('/')]) : `${dir(key)}.json`
  const marker = path.join(root, 'home.json')
  const upgrade = (from: number) => {
    const step = migrations[from] ?? fail(`${root} is a ringi home of version ${from}; this ringi ${build.version} needs version ${HOME_VERSION}`)
    step(state)
    state.write(['home'], {version: from + 1})
  }
  const state: LocalState = {
    root,
    present: () => fs.existsSync(root),
    ensure: () => {
      if (fs.existsSync(marker)) {
        for (let v = readJson<{version?: number}>(marker, {}).version ?? 0; v !== HOME_VERSION; v++) upgrade(v)
        return
      }
      if (fs.existsSync(root) && fs.readdirSync(root).length) fail(`${root} exists and is not a ringi home (no home.json); move it away or set RINGI_HOME`)
      mkdirIn(root, root)
      state.write(['home'], {version: HOME_VERSION})
    },
    locked: (name, fn) => {
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
      try { names = fs.readdirSync(dir(key)) } catch {}
      return [...new Set(names.map(n => n.replace(/\.json$/, '')))].sort()
    },
    place: key => {
      mkdirIn(root, dir(key))
      return dir(key)
    },
  }
  return state
}
