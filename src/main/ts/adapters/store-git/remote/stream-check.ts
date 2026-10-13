// One stream record: structure, dependencies and admitted signature. Null means a dependency is not fetched yet.
import * as C from '../../../lib/index.ts'
import {ancestor, git, rev} from './git.ts'
import {streamFacts} from './stream-facts.ts'
import type {Facts, StreamKind} from './stream-facts.ts'
import {streamAdmission} from './stream-control.ts'
import type {Dependencies} from './stream-control.ts'
import type {Handle, Raw, Room} from './types.ts'
export type CheckContext = {H: Handle, R: Room, actor: string, kind: StreamKind, parent: string, dep: Dependencies}
const frame = ({H, actor, parent}: CheckContext, c: Raw): void => {
  if (c.parents.length !== 1 || c.parents[0] !== parent) C.fail('stream is not one linear continuation of its room genesis')
  if (c.author !== actor || c.committer !== actor) C.fail('stream author and committer must be its actor')
  if (c.tree !== git(H, ['rev-parse', `${parent}^{tree}`]).trim()) C.fail('stream changes its parent tree')
}
const controlReady = ({H, R, dep}: CheckContext, control: string): boolean => {
  if (dep.controls.has(control)) return true
  if (dep.messages.has(control) || dep.skipped.has(control)) C.fail('stream Control is not an accepted root control')
  if (rev(H, control) && !ancestor(H, R.genesis, control)) C.fail('stream Control belongs to another history')
  return false
}
const targetReady = ({H, R, dep, kind}: CheckContext, target: string): boolean => {
  if (dep.messages.has(target)) return true
  if (kind === 'telemetry' && dep.controls.has(target)) return true
  if (dep.controls.has(target) || dep.skipped.has(target)) C.fail('signal Target is not an accepted chat message')
  if (rev(H, target) && !ancestor(H, R.genesis, target)) C.fail('stream Target belongs to another history')
  return false
}
export const checkStreamRecord = (ctx: CheckContext, c: Raw): Facts | null => {
  frame(ctx, c)
  const f = streamFacts(c, ctx.kind), control = f.get('Control')!, target = f.get('Target')!
  if (f.get('Room') !== ctx.R.genesis) C.fail('stream names another room genesis')
  if (!controlReady(ctx, control) || !targetReady(ctx, target)) return null
  streamAdmission(ctx.H, control, ctx.actor, c.sha)
  return f
}
