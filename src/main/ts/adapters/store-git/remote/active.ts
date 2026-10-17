// A local new write uses current verified membership and the explicitly selected key, before making a commit.
import {fail} from '../../../lib/index.ts'
import {branch} from './branch.ts'
import {rev} from './git.ts'
import {identityKey} from './keys.ts'
import type {Handle, Room} from './types.ts'

export const requireActive = (H: Handle, R: Room, actor: string): void => {
  if (H.layout !== 'git/4') return
  const tip = rev(H, R.ref) ?? fail('room branch is missing'), room = branch(H, R, tip)
  if (!Object.hasOwn(room.members, actor)) return fail('actor is not active or is permanently retired in this room')
  if (H.d.trust === 'asserted') return
  const admitted = room.entries.find(e => e.principal === actor)?.key
  if (!admitted || admitted.line !== identityKey(H, actor).line) fail('selected local keyRef does not match the active admitted actor key')
}
