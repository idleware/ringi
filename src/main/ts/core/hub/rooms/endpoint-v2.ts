// Validate the future local endpoint without broadening the active endpoint/1 gate.
import type {RoomEndpointV2} from '../ports/store.ts'
import {badRegistration as bad, directory, record, reference, revision, roomName, token} from './registration-checks.ts'
import {addressName, canonicalRoom} from './room-registration.ts'
import type {RegistrationOwner} from './room-registration.ts'

const relativeStore = (v: unknown): boolean => {
  if (!record(v) || typeof v.path !== 'string' || !/^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*$/.test(v.path)) return false
  return v.path.split('/').every(p => p !== '.' && p !== '..')
}
const checkReferences = (v: Record<string, unknown>): void => {
  const store = v.store as Record<string, unknown>
  if (![v.keyRef, v.authRef, store.remote].every(reference)) bad('invalid local identity or transport reference')
  if (v.hostKeys !== undefined && (!Array.isArray(v.hostKeys) || !v.hostKeys.every(x => typeof x === 'string' && !!x))) bad('invalid host pins')
  if (v.pendingRefs !== undefined && (!record(v.pendingRefs) || !Object.values(v.pendingRefs).every(x => typeof x === 'string' && reference(x)))) bad('invalid pending identity references')
}
const receiptMatches = (e: RoomEndpointV2): boolean => {
  const r = e.receipt
  if (!r) return true
  const identity = r.address === e.address && r.genesis === e.genesis && token(r.reservation)
  const location = r.directory?.path === e.location.directory.path && r.directory.identity === e.location.directory.identity
  return identity && location
}
const checkDisposal = (e: RoomEndpointV2): void => {
  if (!receiptMatches(e)) bad('creation receipt does not belong to this repository')
  if (!e.disposal) return
  if (!e.receipt || !['prepared', 'repository-removed'].includes(e.disposal.phase)) bad('invalid disposal receipt or phase')
  if (!receiptMatches({...e, receipt: e.disposal.receipt}) || e.disposal.receipt.reservation !== e.receipt!.reservation) bad('invalid disposal receipt or phase')
}
export const checkEndpointV2 = (v: unknown, owner: RegistrationOwner, {creating = false}: {creating?: boolean} = {}): RoomEndpointV2 => {
  if (!record(v) || v.schema !== 'ringi-room/2' || typeof v.address !== 'string') return bad('endpoint/2 required')
  canonicalRoom(v.address)
  if (!roomName(v.name) || !(revision(v.genesis) || creating && v.genesis === '')) return bad('invalid room identity')
  addressName(v.address, v.name)
  if (v.hubGenesis !== owner.genesis || v.trust !== owner.trust || v.root !== owner.root) bad('endpoint changed hub, trust or root pins')
  if (!record(v.location) || !directory(v.location.directory) || !token(v.location.generation)) return bad('invalid repository incarnation')
  if (!relativeStore(v.store)) return bad('store.path must stay relative to the selected directory')
  checkReferences(v)
  const e = v as RoomEndpointV2
  if (creating && (e.genesis || e.receipt || e.disposal)) bad('creation endpoint must have no prior genesis or ownership receipt')
  checkDisposal(e)
  return e
}
