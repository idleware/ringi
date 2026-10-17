// One namespace rename includes its registration and invitations. Archives retain all bytes and retry evidence.
import fs from 'node:fs'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {fail, strictJson} from '../../lib/index.ts'
import type {StateArchive} from '../../core/hub/ports/state.ts'
import type {RoomDirectory} from '../../core/hub/ports/location.ts'
import {canonical, check, entryExists} from '../fs/directory.ts'
import {guardWrite} from '../fs/write.ts'

type Intent = {schema: 'ringi-state-archive/1', hash: string, source: RoomDirectory, parent: RoomDirectory, home: RoomDirectory, destination: RoomDirectory}
const bad = (why: string): never => fail(`state archive: ${why}; archive and remaining namespace are retained`)
const segment = (s: string): string => !s || s === '.' || s === '..' || /[/\\\0]/.test(s) ? bad('unsafe key or token') : s
const directory = (at: string): RoomDirectory => {
  const found = canonical(at)
  return found?.path === at ? found : bad('directory is missing or redirected')
}
const namespacePath = (root: string, request: StateArchive): string => {
  if (!request.key.length || !request.record.length) return bad('empty namespace or record')
  request.key.forEach(segment); request.record.forEach(segment); segment(request.token)
  return path.join(root, ...request.key)
}
const hashOf = (request: StateArchive): string => createHash('sha256').update(JSON.stringify(request)).digest('hex')
const checkRecord = (at: string, request: StateArchive): void => {
  parents(at, request.record)
  const file = path.join(at, ...request.record) + '.json', stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink()) bad('expected record is not a regular file')
  const value = strictJson<unknown>(fs.readFileSync(file, 'utf8'), 'archived namespace record')
  if (JSON.stringify(value) !== JSON.stringify(request.value)) bad('namespace incarnation or record changed')
}
const parents = (root: string, key: readonly string[]): void => {
  let at = root
  directory(at)
  for (const name of key.slice(0, -1)) { at = path.join(at, name); directory(at) }
}
const prepare = (root: string, request: StateArchive, source: string): Intent => {
  parents(root, request.key)
  const object = directory(source)
  if (entryExists(source + '.json')) return bad('namespace has a sibling record')
  checkRecord(source, request)
  const archives = path.join(root, 'room-archives')
  try { fs.mkdirSync(archives, {mode: 0o700}) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e }
  directory(archives)
  const destination = path.join(archives, request.token)
  fs.mkdirSync(destination, {mode: 0o700})
  const intent: Intent = {schema: 'ringi-state-archive/1', hash: hashOf(request), source: object,
    parent: directory(path.dirname(source)), home: directory(root), destination: directory(destination)}
  if (fs.statSync(intent.parent.path).dev !== fs.statSync(destination).dev) return bad('cross-device namespace archive is unsupported')
  fs.writeFileSync(path.join(destination, 'intent.json'), JSON.stringify(intent), {flag: 'wx', mode: 0o600})
  return intent
}
const intentFor = (root: string, request: StateArchive, source: string): Intent => {
  const destination = path.join(root, 'room-archives', request.token)
  if (!entryExists(destination)) return prepare(root, request, source)
  directory(path.dirname(destination)); directory(destination)
  const file = path.join(destination, 'intent.json'), stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32768) return bad('archive intent is not a bounded regular file')
  const saved = strictJson<Intent>(fs.readFileSync(file, 'utf8'), 'state archive intent')
  if (saved?.schema !== 'ringi-state-archive/1' || saved.hash !== hashOf(request) || saved.source.path !== source || saved.destination.path !== destination) return bad('archive intent changed')
  return saved
}
export const archiveState = (root: string, request: StateArchive): string => guardWrite(root, () => {
  // The selected home may have a symlinked ancestor. Namespace children must still be exact pinned objects.
  root = (canonical(root) ?? bad('home is missing')).path
  const source = namespacePath(root, request), intent = intentFor(root, request, source)
  parents(root, request.key)
  check(intent.home); check(intent.parent); check(intent.destination)
  const destination = path.join(intent.destination.path, 'namespace'), old = canonical(source), archived = canonical(destination)
  if (old) {
    if (old.path !== source || old.identity !== intent.source.identity || entryExists(destination)) return bad('source changed or archive destination is occupied')
    checkRecord(source, request)
    fs.renameSync(source, destination)
  } else if (entryExists(source) || archived?.path !== destination || archived.identity !== intent.source.identity) return bad('missing source is not proof of completed archive')
  check(intent.home); check(intent.parent); check(intent.destination)
  if (entryExists(source) || canonical(destination)?.path !== destination || canonical(destination)?.identity !== intent.source.identity) return bad('post-rename namespace identity changed')
  checkRecord(destination, request)
  return destination
})
