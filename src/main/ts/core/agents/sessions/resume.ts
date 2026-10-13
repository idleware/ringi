// resume: a chat continues its own seat after a restart, or takes over one the operator names.

import {hubPorts, locked} from '../../hub/ports/index.ts'
import {fail, note, stamp} from '../../../lib/index.ts'
import type {Me, Session} from './index.ts'
import {allSessions, dropSession, liveness, ownSession, parseSelector, saveSession, whoAmI} from './index.ts'

export const resume = (selector?: string): Session => {
  const me = whoAmI()
  hubPorts().state.ensure()
  return locked('sessions', () => {
    const target = selectTarget(me, selector)
    takeOver(me, target)
    const session = resumed(me, target)
    saveSession(session)
    return session
  })
}

const selectTarget = (me: Me, selector?: string): Session => {
  if (!selector) {
    return ownTarget(me)
  } else {
    const sel = parseSelector(selector)
    return allSessions().find(s => s.room === sel.room && s.agent === sel.agent) ?? fail(`no session holds ${selector}; the operator joins this chat with ringi join`)
  }
}

const ownTarget = (me: Me): Session => {
  const mine = ownSession(me.handle)
  if (!mine) {
    const cands = allSessions().filter(s => liveness(s) !== 'active').sort((a, b) => Number(b.product === me.product) - Number(a.product === me.product))
    if (!cands.length) fail('nothing to continue: this chat was never joined, and no paused or gone session waits. The operator says "join <room> as <id>"')
    fail(`this chat has no binding of its own. Say which one to take over:\n${cands.map(s => `  ringi continue ${s.room}/${s.agent}   (${liveness(s)}, ${s.product ?? '?'}, ${s.handle}${s.scope ? `, scope: ${s.scope}` : ''})`).join('\n')}`)
  }
  return mine!
}

const takeOver = (me: Me, target: Session): void => {
  if (target.handle !== me.handle) {
    if (liveness(target) === 'active') fail(`${target.room}/${target.agent} is held by a live session (${target.handle}); it is not taken over`)
    dropSession(target.handle)
    note(`took over ${target.room}/${target.agent} from ${target.handle}`)
  }
}

const resumed = (me: Me, target: Session): Session => {
  const session: Session = {
    ...target, handle: me.handle, product: target.handle === me.handle ? target.product : me.product, state: 'active',
    since: target.handle === me.handle ? target.since : stamp(), lastSeen: stamp(), pid: me.pid ?? (target.handle === me.handle ? target.pid : null)
  }
  return session
}
