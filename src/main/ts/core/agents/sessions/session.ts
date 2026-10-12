import {locked} from '../../hub/ports/index.ts'
import {start} from '../../hub/rooms/index.ts'
import {fail, stamp} from '../../../lib/index.ts'
import type {Session} from './index.ts'
import {bound, dropSession, ownSession, saveSession, whoAmI} from './index.ts'
import {inbox} from './agent.ts'
import {tasks} from '../../hub/usecases/room.ts'
export {resume} from './resume.ts'

export {join} from './join.ts'
export type {JoinInput, JoinResult} from './join.ts'

export {bound} from './index.ts'

export type {Session} from './index.ts'

// A room still waiting for its agents is not read: nothing is marked seen before its work starts.
export const briefing = (s: Session) => {
  const actor = bound()
  const st = start(actor.R)
  return {session: s, actor, start: st, tasks: st.started ? tasks(actor).views : [], inbox: st.started ? inbox(actor) : null}
}

export const stop = (): Session => locked('sessions', () => {
  const s = ownSession(whoAmI().handle) ?? fail('this session is in no room')
  const stopped: Session = {...s, state: 'stopped', lastSeen: stamp()}
  saveSession(stopped)
  return stopped
})

export const leave = (): Session => locked('sessions', () => {
  const s = ownSession(whoAmI().handle) ?? fail('this session is in no room')
  dropSession(s.handle)
  return s
})
