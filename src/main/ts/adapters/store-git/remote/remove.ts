// Whole-member terminal removal: pinned-root signed or explicit asserted operator control. Medium rights/custody
// remain outside this adapter.
import {fail} from '../../../lib/index.ts'
import {AGENT_RE, compose} from '../../../core/hub/protocol/index.ts'
import {branch} from './branch.ts'
import {git, ident, isRemote, rev} from './git.ts'
import {treeWith} from './control-tree.ts'
import {membershipText} from './membership.ts'
import {signerLine} from './keys.ts'
import {signCommit} from '../signing.ts'
import {push} from './push.ts'
import type {Branch, Handle, Room} from './types.ts'
import {ROOT} from './types.ts'

const removalCommit = (H: Handle, room: Branch, actor: string, tip: string): string => {
  const key = isRemote(H) ? room.entries.find(e => e.principal === actor)?.key.fp ?? fail('removed actor has no admitted key') : null
  const members = Object.fromEntries(Object.entries(room.members).filter(([who]) => who !== actor))
  const retired = {...room.retired, [actor]: {key, since: new Date().toISOString()}}
  const roster = room.entries.filter(e => e.principal !== actor).map(e => signerLine(e.principal, e.key)).join('')
  const tree = treeWith(H, tip, room.control.at(-1)!, {'members.json': membershipText({members, retired}, 'git/4'), allowed_signers: roster})
  const sha = git(H, ['commit-tree', tree, '-p', tip], {input: compose(`remove ${actor}`, [['To', '*'], ['Kind', 'room']]), env: ident(ROOT)}).trim()
  return signCommit(H, ROOT, sha)
}
const removalTarget = (H: Handle, by: string, actor: string): void => {
  if (H.layout !== 'git/4') fail('member removal requires explicit git/4')
  if (by !== ROOT || actor === ROOT) fail('only operator removes another member; root removal is refused')
  if (!AGENT_RE.test(actor) || actor === 'main' || actor === 'chat') fail('invalid removal actor')
}
const removalAttempt = (H: Handle, R: Room, actor: string): string | null => {
  const tip = rev(H, R.ref) ?? fail('room branch is missing'), room = branch(H, R, tip)
  if (Object.hasOwn(room.retirements ?? {}, actor)) return push(H, R.ref, {behind: true}) ? room.retirements![actor] : null
  if (!Object.hasOwn(room.members, actor)) fail('actor is not an active member')
  const sha = removalCommit(H, room, actor, tip)
  if (git(H, ['update-ref', R.ref, sha, tip], {ok: true}).status !== 0) return null
  if (!push(H, R.ref, {behind: true})) return null
  R.head = sha
  return sha
}
export const roomRemove = (H: Handle, R: Room, by: string, actor: string): string => {
  removalTarget(H, by, actor)
  for (let attempt = 0; attempt < 8; attempt++) {
    const published = removalAttempt(H, R, actor)
    if (published) return published
  }
  return fail('room kept moving while removing a member; retry')
}
