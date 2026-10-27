// Managed leaves are quarantined by rename, never recursively erased. Allocation is independent of Git history.
import fs from 'node:fs'
import path from 'node:path'
import {createHash, randomUUID} from 'node:crypto'
import {fail, sameObject, strictJson} from '../../lib/index.ts'
import type {RoomDirectory, RoomQuarantine} from '../../core/hub/ports/location.ts'
import {canonical, check, entryExists} from '../fs/directory.ts'
import {guardWrite} from '../fs/write.ts'

type Allocation = {schema: 'ringi-allocation/1', source: RoomDirectory, home: RoomDirectory, parent: RoomDirectory}
const same = (a: RoomDirectory | null, b: RoomDirectory): boolean => a?.path === b.path && sameObject(a.identity, b.identity)
const bad = (why: string): never => fail(`managed room quarantine: ${why}; files are retained`)
const managedParent = (source: RoomDirectory, home: RoomDirectory): RoomDirectory | null => {
  const parent = path.dirname(source.path)
  if (![path.join(home.path, 'rooms'), path.join(home.path, 'clones')].includes(parent)) return null
  const found = canonical(parent)
  return found?.path === parent ? found : bad('managed parent is redirected or missing')
}
const privateDirectory = (home: RoomDirectory, name: string): RoomDirectory => {
  check(home)
  const at = path.join(home.path, name)
  try { fs.mkdirSync(at, {mode: 0o700}) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e }
  const found = canonical(at)
  if (found?.path !== at) return bad('private directory is redirected or missing')
  check(home)
  return found
}
const allocationFile = (source: RoomDirectory, home: RoomDirectory): string =>
  path.join(home.path, 'room-allocations', createHash('sha256').update(source.identity).digest('hex') + '.json')
export const recordAllocation = (source: RoomDirectory, home: RoomDirectory): void => {
  const parent = managedParent(source, home)
  if (!parent) return
  privateDirectory(home, 'room-allocations')
  const allocation: Allocation = {schema: 'ringi-allocation/1', source, home, parent}
  fs.writeFileSync(allocationFile(source, home), JSON.stringify(allocation), {flag: 'wx', mode: 0o600})
  check(source); check(parent); check(home)
}
const allocation = (source: RoomDirectory, home: RoomDirectory): Allocation => {
  const parent = managedParent(source, home) ?? bad('only an exclusively allocated managed leaf can be removed')
  const storage = canonical(path.join(home.path, 'room-allocations'))
  if (storage?.path !== path.join(home.path, 'room-allocations')) return bad('allocation storage is redirected or missing')
  const file = allocationFile(source, home), stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) return bad('allocation witness is not a bounded regular file')
  const saved = strictJson<Allocation>(fs.readFileSync(file, 'utf8'), 'room allocation')
  if (saved?.schema !== 'ringi-allocation/1' || !same(saved.source, source) || !same(saved.home, home) || !same(saved.parent, parent)) return bad('allocation witness changed its directory pins')
  return saved
}
export const planQuarantine = (source: RoomDirectory, root: string): RoomQuarantine => guardWrite(root, () => {
  const home = canonical(root) ?? bad('home is missing')
  check(source)
  const {parent} = allocation(source, home), trash = privateDirectory(home, 'trash')
  if (fs.statSync(parent.path).dev !== fs.statSync(trash.path).dev) return bad('cross-device quarantine is unsupported')
  return {source, home, parent, trash, destination: path.join(trash.path, 'room-' + randomUUID())}
})
const validatePlan = (plan: RoomQuarantine, root: string): void => {
  if (!same(canonical(root), plan.home)) bad('home changed identity')
  const saved = allocation(plan.source, plan.home)
  if (!same(saved.parent, plan.parent) || plan.trash.path !== path.join(plan.home.path, 'trash')) bad('quarantine parent changed')
  if (path.dirname(plan.destination) !== plan.trash.path || !/^room-[a-f0-9-]{36}$/.test(path.basename(plan.destination))) bad('invalid destination')
  check(plan.home); check(plan.parent); check(plan.trash)
}
export const quarantine = (plan: RoomQuarantine, root: string): RoomDirectory => guardWrite(root, () => {
  validatePlan(plan, root)
  const source = canonical(plan.source.path), destination = canonical(plan.destination)
  if (source) {
    if (!same(source, plan.source) || entryExists(plan.destination)) return bad('source changed or destination is occupied')
    // The private destination is unused under the caller's object lock; no OS-level no-replace claim is made.
    fs.renameSync(plan.source.path, plan.destination)
  } else if (entryExists(plan.source.path) || destination?.path !== plan.destination || !sameObject(destination.identity, plan.source.identity)) return bad('neither a pinned source nor its exact quarantined object exists')
  validatePlan(plan, root)
  const moved = canonical(plan.destination)
  if (entryExists(plan.source.path) || !moved || !sameObject(moved.identity, plan.source.identity) || moved.path !== plan.destination) return bad('post-rename object check failed')
  return moved
})
