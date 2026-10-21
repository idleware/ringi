// Gitea 1.25–1.27 account spaces, with explicit numeric priorities and force-push refusal read back.
import type {AccessType} from '../../core/hub/ports/access.ts'
import {Context} from './context.ts'
import {account, accountKeys, ownKey} from './accounts.ts'
import {ensureRoom, deleteServer} from './repos.ts'
import {grant, revoke} from './grants.ts'

export const giteaAccess: AccessType = (locator, authRef) => {
  const c = new Context(locator, authRef)
  return {
    inspect: async () => ({version: await c.version(), principal: await c.root(),
      can: {actorBranches: true, privateRepos: true, deleteServer: true, refuseForcePush: true, accountKeys: true, deployKeys: false, hostKeysByApi: false}}),
    ownKey: async key => { await c.version(); await ownKey(c.api, key) },
    account: login => account(c.api, login), accountKeys: a => accountKeys(c.api, a),
    effective: room => c.effective(room), ensureRoom: room => ensureRoom(c, room), deleteServer: room => deleteServer(c, room),
    grant: (room, actor, principal, key) => grant(c, {room, actor, principal, key}),
    revoke: (room, actor, principal) => revoke(c, {room, actor, principal}),
  }
}
