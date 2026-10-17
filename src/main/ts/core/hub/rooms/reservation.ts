// Canonical, complete create intent: no lossy JSON conversion or redrawn invitation ids on retry.
import {badRegistration, record} from './registration-checks.ts'
import type {ReservationValue, RoomReservation} from './room-registration.ts'
import {directory, token} from './registration-checks.ts'
import path from 'node:path'
import {checkProvision} from './provision-remote.ts'

const ordered = (v: unknown, seen: Set<object>): ReservationValue => {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (!v || typeof v !== 'object' || seen.has(v)) return badRegistration('reservation parameters must be finite, acyclic JSON')
  if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) badRegistration('reservation parameters must be plain JSON')
  seen.add(v)
  if (Array.isArray(v) && (Object.keys(v).length !== v.length || Array.from(v.keys()).some(i => !Object.hasOwn(v, i)))) return badRegistration('reservation arrays must have no holes or extra properties')
  const result = Array.isArray(v) ? v.map(x => ordered(x, seen))
    : Object.fromEntries(Object.keys(v).sort().map(k => [k, ordered((v as Record<string, unknown>)[k], seen)]))
  seen.delete(v)
  return result
}
// Persist the complete caller-supplied create intent, not only a hash: retries retain invitation ids and modes.
export const reservationParameters = (v: Record<string, ReservationValue>): string => {
  if (!record(v)) return badRegistration('reservation parameters must be an object')
  return JSON.stringify(ordered(v, new Set()))
}

export const checkReservation = (v: unknown): RoomReservation => {
  if (!record(v) || !token(v.operation) || !token(v.generation) || typeof v.parameters !== 'string') return badRegistration('invalid create reservation')
  if (reservationParameters(JSON.parse(v.parameters)) !== v.parameters) return badRegistration('noncanonical create intent')
  if (v.preparation !== undefined) checkPreparation(v.preparation)
  if (v.provision !== undefined) checkProvision(v.provision)
  return v as RoomReservation
}
const checkPreparation = (v: unknown): void => {
  if (!record(v) || typeof v.target !== 'string') return badRegistration('invalid creation target')
  if (!path.isAbsolute(v.target) || v.target !== path.normalize(v.target) || v.target.includes('\0')) badRegistration('invalid creation target')
  const p = v as Record<string, unknown>
  if (p.phase !== 'allocated' && p.phase !== 'initializing') badRegistration('invalid preparation phase')
  if (p.directory !== undefined && !directory(p.directory)) badRegistration('invalid prepared directory')
  if (p.phase === 'initializing' && p.directory === undefined) badRegistration('initializing creation has no pinned directory')
}
export const copyRecord = <T>(v: T): T => JSON.parse(JSON.stringify(v))
export const equalRecord = (a: unknown, b: unknown): boolean =>
  reservationParameters(copyRecord(a) as Record<string, never>) === reservationParameters(copyRecord(b) as Record<string, never>)
