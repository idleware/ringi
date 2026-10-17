// Local initialization evidence, never published. A denied empty fetch can retry without erasing its directory.
import fs from 'node:fs'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {fail, strictJson} from '../../lib/index.ts'
import {writeJsonAtomic} from '../fs/index.ts'
import type {Descriptor, RoomEndpointV2} from '../../core/hub/ports/store.ts'
import {checkRepositoryPath} from './location.ts'

type Phase = 'initializing' | 'denied' | 'complete'
type Witness = {schema: 'ringi-attachment/1', endpoint: string, phase: Phase}
const witnessFile = (at: string) => path.join(at, 'ringi-attachment.json')
const endpointToken = (d: Descriptor, e: RoomEndpointV2): string => createHash('sha256').update(JSON.stringify([
  d.name, d.genesis, d.trust, d.root ?? null, e.address, e.name, e.hubGenesis, e.genesis, e.trust, e.root ?? null,
  e.location.directory.path, e.location.directory.identity, e.location.generation,
  e.store.path, e.store.remote ?? null, e.keyRef ?? null, e.authRef ?? null, e.hostKeys ?? [],
])).digest('hex')
const witness = (at: string, d: Descriptor, e: RoomEndpointV2): Witness => {
  const file = witnessFile(at), stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return fail('attachment witness is not a bounded regular file')
  const w = strictJson<Witness>(fs.readFileSync(file, 'utf8'), 'attachment witness')
  if (!w || w.schema !== 'ringi-attachment/1' || w.endpoint !== endpointToken(d, e) || !['initializing', 'denied', 'complete'].includes(w.phase)) {
    return fail('attachment witness changed its endpoint pins or directory incarnation')
  }
  return w
}
const emptyDirectory = (dir: string): boolean => {
  const s = fs.lstatSync(dir)
  return s.isDirectory() && !s.isSymbolicLink() && fs.readdirSync(dir).length === 0
}
export const emptyAttachment = (at: string, e: RoomEndpointV2): boolean => {
  checkRepositoryPath(at, e)
  const dir = path.join(at, e.store.path, '.git'), objects = path.join(dir, 'objects'), refs = path.join(dir, 'refs')
  if (fs.existsSync(path.join(dir, 'packed-refs')) || fs.existsSync(path.join(dir, 'shallow'))) return false
  if (fs.readdirSync(objects).sort().join(',') !== 'info,pack' || fs.readdirSync(refs).sort().join(',') !== 'heads,tags') return false
  return ['info', 'pack'].every(p => emptyDirectory(path.join(objects, p))) && ['heads', 'tags'].every(p => emptyDirectory(path.join(refs, p)))
}
export const startAttachment = (at: string, d: Descriptor, e: RoomEndpointV2, initialize: () => void): void => {
  if (!fs.readdirSync(at).length) {
    initialize()
    fs.writeFileSync(witnessFile(at), JSON.stringify({schema: 'ringi-attachment/1', endpoint: endpointToken(d, e), phase: 'initializing'}), {flag: 'wx', mode: 0o600})
    return
  }
  const w = witness(at, d, e)
  if (w.phase === 'complete') return
  if (w.phase !== 'denied' || !emptyAttachment(at, e)) return fail('attachment has unverified partial initialization; repository is retained')
  writeJsonAtomic(witnessFile(at), {...w, phase: 'initializing'})
}
export const attachmentPhase = (at: string, d: Descriptor, e: RoomEndpointV2, phase: Phase): void => {
  const w = witness(at, d, e)
  writeJsonAtomic(witnessFile(at), {...w, phase})
}
