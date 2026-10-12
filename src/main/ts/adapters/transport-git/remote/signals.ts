import * as C from '../../../lib/index.ts'
import * as P from '../../../core/hub/protocol/index.ts'
import {branch} from './branch.ts'
import {git, isRemote, reason, rev} from './git.ts'
import {heartbeatName} from './heartbeat.ts'
import {checkSignature} from './signature.ts'
import type {Handle, Room} from './types.ts'
import {SHA, TAGS} from './types.ts'

export const SIGNAL_NAME = /^([a-z0-9]+(?:[_-][a-z0-9]+)*)\.([a-z][a-z0-9.-]*)\.([0-9a-f]{12})$/

export const signalName = (ref: string): {actor: string, id: string, signal: string} => {
  if (heartbeatName(ref)) C.fail('heartbeat is not an immutable signal')
  const m = ref.startsWith(TAGS) && SIGNAL_NAME.exec(ref.slice(TAGS.length))
  if (!m) return C.fail('malformed signal tag namespace')
  return {actor: m[1], id: m[3], signal: m[2]}
}

// The signed header carries the full target, tag name and actor; there is no message body.
export const signalObject = (H: Handle, ref: string, sha: string) => {
  const s = signalName(ref)
  if (git(H, ['cat-file', '-t', sha]).trim() !== 'tag') C.fail('signal must be an annotated tag')
  const text = P.decodeText(git(H, ['cat-file', 'tag', sha], {raw: true}))
  if (text.invalid) C.fail(`signal tag is ${text.invalid}`)
  const [header, ...rest] = text.text!.split('\n\n')
  const target = /^object ([0-9a-f]+)\ntype commit\ntag ([^\n]+)\ntagger ([^<\n]+) <[^\n]*> \d+ [+-]\d{4}\n?$/.exec(header) ?? C.fail('malformed signal tag headers')
  if (!SHA.test(target[1]) || !target[1].startsWith(s.id) || target[2] !== ref.slice('refs/tags/'.length) || target[3].trim() !== s.actor) C.fail('signal tag name, actor or target disagrees')
  const body = rest.join('\n\n').split('-----BEGIN SSH SIGNATURE-----')[0]
  if (body !== '') C.fail('signal tag message must be empty')
  return {...s, message: target[1]}
}

// Derived signals belong to their message's author; read/taken marks may name another member's message.
// The room is determined by the full target commit on its verified branch, never by a short name or a tag body.
export const checkSignal = (H: Handle, R: Room, ref: string, sha: string): void => {
  const s = signalObject(H, ref, sha)
  const b = branch(H, R, rev(H, R.ref) ?? C.fail('signal room has no branch here'))
  const signer = b.entries.find(e => e.principal === s.actor) ?? C.fail(`unadmitted signal principal ${s.actor}`)
  checkSignature(H, sha, s.actor, signer.key, 'tag')
  const mark = s.signal === 'read' || s.signal === 'taken'
  if (s.message === R.genesis) C.fail('signal points at no message of this room')
  const author = b.authors.get(s.message)
  if (!(mark ? author : author === s.actor)) C.fail(`signal points at no accepted message ${mark ? 'of this room' : 'of its actor'}`)
}

export const verifySignal = (H: Handle, R: Room, ref: string, sha: string): string | null => {
  if (!isRemote(H)) return null
  const alarm = H.remoteAlarms?.[ref]
  if (alarm) return alarm
  try {checkSignal(H, R, ref, sha); return null} catch (e) {return reason(e)}
}
