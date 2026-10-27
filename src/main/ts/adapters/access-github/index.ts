// access-github: a GitHub organisation as a space (`github://github.com/<org>`), one private repository per room. A free
// organisation's private repositories get no branch protection, so GitHub cannot keep an actor to its own branch: the
// root is the repository's only collaborator, and each actor reaches its room with a write deploy key of that
// repository, which the root vouches for (deploy-key mode, hub-2). Account mode, an actor through its own account held
// to its own branch, needs a plan that protects branches and is not here yet. What is reported is what the API reads
// back.

import {fail} from '../../lib/index.ts'
import type {Access, AccessType} from '../../core/hub/ports/access.ts'
import {spaceOf} from './space.ts'
import type {Org} from './space.ts'
import {account, accountKeys, deployKey, deployKeys, dropDeployKey, hostKeys, ownKey} from './keys.ts'
import {deleteServer, effective, ensureRoom} from './repos.ts'

const OPERATOR = 'operator'
const ACCOUNT_MODE = 'GitHub rooms take deploy keys here: keeping an account to its own branch needs a paid plan, which ringi does not support yet'

const github = (address: string, authRef: string): Access => {
  const S = spaceOf(address, authRef)
  return {
    inspect: async () => {
      const org = await S.call<Org>('GET', `/orgs/${S.org}`) ?? fail(`no GitHub organisation ${S.org}`)
      return {version: `GitHub (${org.plan?.name ?? 'plan unknown'})`, principal: await S.self(),
        can: {actorBranches: false, privateRepos: true, deleteServer: true, refuseForcePush: false, accountKeys: true, deployKeys: true, hostKeysByApi: true}}
    },
    ownKey: key => ownKey(S, key),
    ensureRoom: (room, intent) => ensureRoom(S, room, intent),
    account: login => account(S, login),
    accountKeys: a => accountKeys(S, a),
    grant: async (_room, actor) => fail(actor === OPERATOR ? 'the operator\'s signals are the root\'s' : ACCOUNT_MODE),
    revoke: async () => fail(ACCOUNT_MODE),
    effective: room => effective(S, room),
    deployKey: (room, label, key) => deployKey(S, room, label, key),
    dropDeployKey: (room, record) => dropDeployKey(S, room, record),
    deployKeys: room => deployKeys(S, room),
    hostKeys: () => hostKeys(S),
    deleteServer: (room, id) => deleteServer(S, room, id),
  }
}
export const githubAccess: AccessType = github
