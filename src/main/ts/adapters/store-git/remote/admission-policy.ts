// Admission guards under the explicit wire; a matching git/4 retry makes no additional control.
import {fail} from '../../../lib/index.ts'
import {AGENT_RE} from '../../../core/hub/protocol/model.ts'
import {id, isRemote} from './git.ts'
import {keyInput} from './keys.ts'
import {ROOT} from './types.ts'
import type {Branch, Handle, Key} from './types.ts'

export const admissionKey = (H: Handle, who: string, publicKey: string): Key => {
  id(who)
  if (H.layout === 'git/4' && (!AGENT_RE.test(who) || who === 'main' || who === 'chat')) fail('invalid git/4 actor id')
  if (!isRemote(H)) fail('room admit is for signed hubs; local membership is added by join')
  if (who === ROOT) fail('the root is already pinned; root replacement requires a separate trust transition')
  return keyInput(publicKey)
}

export const admissionRetry = (H: Handle, room: Branch, who: string, key: Key): string | null => {
  if (H.layout === 'git/4') {
    if (Object.hasOwn(room.retired ?? {}, who) || Object.values(room.retired ?? {}).some(r => r.key === key.fp)) fail('retired actor or fingerprint cannot be admitted again')
    if (room.entries.some(e => e.principal === who && e.key.line === key.line)) return room.control.at(-1)!
  }
  if (room.entries.some(e => e.principal === who || e.key.fp === key.fp)) fail('principal or key is already admitted; key rotation is not implemented')
  return null
}
