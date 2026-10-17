// Structural checks shared by the inert E8 catalogue. Trust remains pinned and is never inferred.
import path from 'node:path'
import {fail} from '../../../lib/index.ts'
import {ID_RE} from '../protocol/index.ts'
import type {RegistrationOwner} from './room-registration.ts'

export const badRegistration = (why: string): never => fail(`room registration: ${why}`)
export const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
export const revision = (v: unknown): v is string => typeof v === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(v)
export const token = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(v)
export const roomName = (v: unknown): v is string => typeof v === 'string' && ID_RE.test(v) && v !== 'main' && v !== 'chat'
export const checkOwner = (v: unknown): RegistrationOwner => {
  if (!record(v) || typeof v.name !== 'string' || !ID_RE.test(v.name) || !revision(v.genesis)) return badRegistration('invalid hub owner')
  const trust = v.trust === 'signed' ? typeof v.root === 'string' && !!v.root && !/[\r\n\0]/.test(v.root)
    : v.trust === 'asserted' && v.root === undefined
  if (!trust) return badRegistration('invalid trust or root pin')
  return v as RegistrationOwner
}
export const ownerMatches = (a: RegistrationOwner, b: RegistrationOwner): boolean =>
  a.name === b.name && a.genesis === b.genesis && a.trust === b.trust && a.root === b.root

export const directory = (v: unknown): boolean => {
  if (!record(v) || typeof v.path !== 'string' || typeof v.identity !== 'string' || !v.identity) return false
  return path.isAbsolute(v.path) && v.path === path.normalize(v.path) && !v.path.includes('\0')
}
export const reference = (v: unknown): boolean => v === undefined || typeof v === 'string' && !!v && !/[\r\n\0]/.test(v)
