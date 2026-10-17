// Local removal quarantines an allocated managed leaf and archives its WHOLE namespace; no accepted history is erased.
import {fail} from '../../../lib/index.ts'
import type {RoomDirectory, RoomFiles, RoomQuarantine} from '../ports/location.ts'
import type {LocalState} from '../ports/state.ts'
import {CatalogueRecords} from './catalogue-records.ts'
import type {RoomRegistration} from './room-registration.ts'
import {registrationContext, registrationKey} from './room-registration.ts'
import {contextToken} from './room-context.ts'
import {copyRecord, equalRecord} from './reservation.ts'
import {directoryLock} from './location-creation.ts'
import {checkedRegistration} from './registration-validation.ts'

type Active = RoomRegistration & {phase: 'active'}
export type DeleteOptions = {confirmed: true, mode: 'managed' | 'unregister'}
export type DeletedRegistration = {address: string, mode: DeleteOptions['mode'], archive: string, quarantine?: RoomDirectory, filesRetained: true}
type Deletion = {schema: 'ringi-deletion/1', token: string, expected: Active, mode: DeleteOptions['mode'], phase: 'prepared' | 'quarantined' | 'archived', plan?: RoomQuarantine, archive?: string}
const bad = (why: string): never => fail(`room deletion: ${why}; remaining files and audit are retained`)
const unmarked = (r: Active): Active => { const copy = copyRecord(r); delete copy.deletion; return copy }
const checkCurrent = (records: CatalogueRecords, intent: Deletion): Active => {
  const found = records.get(intent.expected.id)
  if (found?.phase !== 'active' || !equalRecord(unmarked(found), intent.expected)) return bad('registration incarnation changed')
  if (found.deletion && !equalRecord(found.deletion, {token: intent.token, mode: intent.mode})) bad('another deletion is in progress')
  return found
}
const restoreIntent = (prior: Deletion, expected: Active, options: DeleteOptions): Deletion => {
  const token = contextToken({context: registrationContext(expected)})
  if (prior.schema !== 'ringi-deletion/1' || prior.token !== token || prior.mode !== options.mode || !equalRecord(prior.expected, unmarked(expected))) bad('durable deletion intent changed')
  if (!['prepared', 'quarantined', 'archived'].includes(prior.phase)) bad('invalid durable deletion phase')
  if (prior.mode === 'managed' && (!prior.plan || !equalRecord(prior.plan.source, expected.endpoint.location.directory))) bad('quarantine intent changed repository')
  return prior
}
const newIntent = (records: CatalogueRecords, files: RoomFiles, expected: Active, options: DeleteOptions): Deletion => {
  const token = contextToken({context: registrationContext(expected)})
  const intent: Deletion = {schema: 'ringi-deletion/1', token, expected: unmarked(expected), mode: options.mode, phase: 'prepared'}
  checkCurrent(records, intent)
  if (expected.endpoint.disposal) bad('legacy disposal requires its original recovery path')
  if (options.mode === 'managed') {
    if (!files.planQuarantine || !files.quarantine) return bad('managed quarantine is unsupported')
    intent.plan = files.planQuarantine(expected.endpoint.location.directory, records.state.root)
  }
  records.state.write(['room-deletions', token], intent)
  return intent
}
const prepare = (records: CatalogueRecords, files: RoomFiles, expected: Active, options: DeleteOptions): Deletion => {
  if (!records.state.archive) return bad('atomic namespace archive is unsupported')
  const token = contextToken({context: registrationContext(expected)})
  const prior = records.state.read<Deletion | null>(['room-deletions', token], null)
  return prior ? restoreIntent(prior, expected, options) : newIntent(records, files, expected, options)
}
const run = (records: CatalogueRecords, files: RoomFiles, intent: Deletion): DeletedRegistration => {
  const key = ['room-deletions', intent.token], current = records.get(intent.expected.id)
  if (current || intent.phase === 'prepared') {
    const found = checkCurrent(records, intent)
    if (!found.deletion) records.save({...found, deletion: {token: intent.token, mode: intent.mode}})
  }
  let quarantined: RoomDirectory | undefined
  if (intent.mode === 'managed') {
    if (!intent.plan || !files.quarantine) return bad('missing quarantine capability or intent')
    quarantined = files.quarantine(intent.plan, records.state.root)
  }
  if (intent.phase === 'prepared') {
    intent = {...intent, phase: 'quarantined'}
    records.state.write(key, intent)
  }
  const value = {...intent.expected, deletion: {token: intent.token, mode: intent.mode}}
  const archive = records.state.archive!({key: registrationKey(value.id), record: ['registration'], value, token: intent.token})
  records.state.write(key, {...intent, phase: 'archived', archive})
  return {address: value.address, mode: intent.mode, archive, ...(quarantined ? {quarantine: quarantined} : {}), filesRetained: true}
}
export const removeRegistration = (state: LocalState, files: RoomFiles, expected: Active, options: DeleteOptions): DeletedRegistration => {
  registrationKey(expected.id)
  checkedRegistration(expected, expected.id)
  if (options.confirmed !== true || !['managed', 'unregister'].includes(options.mode)) return bad('explicit mode and confirmation are required')
  return state.locked(`room-location-${expected.id}`, () => state.locked(directoryLock(expected.endpoint.location.directory), () => state.locked('room-catalogue-v2', () => {
    const records = new CatalogueRecords(state), intent = prepare(records, files, expected, options)
    return run(records, files, intent)
  })))
}
