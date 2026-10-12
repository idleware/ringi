// session: how a session's scope and a room still waiting for its quorum are shown.

import type {Session} from '../../../core/agents/sessions/session.ts'

// What the session may do on its own: the recorded scope; without one, in a room with a quorum the room's work for it,
// in any other what the operator accepts when asked.
export const scopeLine = (s: Session, quorum = false): string => s.scope
  ?? (quorum ? 'none recorded; the room\'s work for you, split with the other members' : 'none recorded; ask the operator what to accept')

// The line that keeps an agent of a room waiting for its quorum from doing anything yet.
export const waiting = (room: string, st: {quorum: number | null, agents: number}): string =>
  `waiting: room ${room} waits for a quorum of ${st.quorum} agents and has ${st.agents}; nothing to do yet, end the turn. Its work starts by itself at the quorum`
