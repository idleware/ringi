// heartbeat-object: a heartbeat tag object read and checked: its target in the room, its tagger, its signature.

import * as C from '../../../lib/index.ts'
import * as P from '../../../core/hub/protocol/index.ts'
import {branch} from './branch.ts'
import {git, rev} from './git.ts'
import {heartbeatBody} from './heartbeat-facts.ts'
import {heartbeatName} from './heartbeat-name.ts'
import {checkSignature} from './signature.ts'
import type {Handle, Room} from './types.ts'
import {SHA, TAGS} from './types.ts'

export const heartbeatObject = (H: Handle, ref: string, sha: string) => {
  const s = heartbeatName(ref) ?? C.fail('malformed heartbeat namespace')
  if (!SHA.test(sha) || git(H, ['cat-file', '-t', sha]).trim() !== 'tag') C.fail('heartbeat must be an annotated tag')
  if (Number(git(H, ['cat-file', '-s', sha])) > 32768) C.fail('heartbeat object exceeds 32 KiB')
  const decoded = P.decodeText(git(H, ['cat-file', 'tag', sha], {raw: true}))
  if (decoded.invalid) C.fail(`heartbeat tag is ${decoded.invalid}`)
  const [header, ...rest] = decoded.text!.split('\n\n')
  const target = /^object ([0-9a-f]+)\ntype commit\ntag ([^\n]+)\ntagger ([^<\n]+) <[^\n]*> (\d+) [+-]\d{4}\n?$/.exec(header) ?? C.fail('malformed heartbeat tag headers')
  if (!SHA.test(target[1]) || target[2] !== ref.slice(TAGS.length) || target[3].trim() !== s.actor) C.fail('heartbeat tag name or actor disagrees')
  const text = rest.join('\n\n').split('-----BEGIN SSH SIGNATURE-----')[0]
  const genesis = heartbeatBody(text)
  if (!genesis.startsWith(s.genesis12)) C.fail('heartbeat tag name and room genesis disagree')
  return {...s, genesis, target: target[1], time: Number(target[4]), text}
}

export const checkHeartbeat = (H: Handle, R: Room, ref: string, sha: string): void => {
  const s = heartbeatObject(H, ref, sha)
  if (s.genesis !== R.genesis) C.fail('heartbeat belongs to another room genesis')
  const b = branch(H, R, rev(H, R.ref) ?? C.fail('heartbeat room has no branch here'))
  // It is a replica's sync position, not a claim to author or execute the target message.
  if (!b.control.includes(s.target) && !b.authors.has(s.target) && !b.skipped.has(s.target)) C.fail('heartbeat target is not on this room branch')
  const signer = b.entries.find(e => e.principal === s.actor) ?? C.fail(`unadmitted heartbeat principal ${s.actor}`)
  checkSignature(H, sha, s.actor, signer.key, 'tag')
}
