// access-forgejo: a Forgejo organisation as a space (`forgejo://forge.example/<org>`), one private
// repository per room, and who may push which branch, through Forgejo's API. Principals are Forgejo accounts: a
// writable deploy key can be allowed on a protected branch only together with every other one, so it cannot keep one
// actor to its signals. main, chat and the operator's signals take the root's account (chat also each admitted
// actor's), an actor's signals only its own, every other branch nobody, every tag the root alone (rules.ts). What is reported is
// what the API reads back.

import crypto from 'node:crypto'
import {fail} from '../../lib/index.ts'
import type {Access, AccessType} from '../../core/hub/ports/access.ts'
import type {Call} from './api.ts'
import {caller, space, typed} from './api.ts'
import {rulesOf, signalsOf} from './rules.ts'
import {account, accountKeys, keyLine} from './accounts.ts'

// The root's own actor, whose signals the root's account writes.
const OPERATOR = 'operator'

// An account keeps each key under a title of its own: ringi's is the key's fingerprint, shortened, so another key titled
// alike, or the same operator's root key of another hub, never collides with it.
const titleOf = (line: string) => `ringi SHA256:${crypto.createHash('sha256').update(Buffer.from(line.split(' ')[1] ?? '', 'base64')).digest('base64').slice(0, 16)}`
const keysOf = async (call: Call, path: string, who: string) =>
  ((await call<Array<{key: string}>>('GET', path)) ?? fail(`no Forgejo account ${who}`)).map(k => keyLine(k.key))
// A key on an account, written if missing and read back; `then` says what to run once it is added by hand.
type KeyPlace = {read: string, write: string, who: string, then: string}
const keyOn = async (call: Call, {read, write, who, then}: KeyPlace, key: string) => {
  const line = keyLine(key)
  if ((await keysOf(call, read, who)).includes(line)) return
  const r = await call<unknown>('POST', write, {title: titleOf(line), key: line, read_only: false}).catch((e: Error) => e)
  if (r instanceof Error) fail(`${r.message}; add this key to ${who}'s SSH keys on the forge by hand, then ${then}: ${line}`)
  if (!(await keysOf(call, read, who)).includes(line)) fail(`the key is not on ${who}'s account after adding it: ${line}`)
}
// The actor's public key on its account, so the forge knows who pushes; an admin token may put it there, any other is
// told where the operator adds it by hand.
const enrol = (call: Call, principal: string, key: string) =>
  keyOn(call, {read: `/users/${encodeURIComponent(principal)}/keys`, write: `/admin/users/${encodeURIComponent(principal)}/keys`, who: principal, then: 'admit again'}, key)

// One space's calls, its repositories' paths and rules, and whose the token is.
type Space = {call: Call, org: string, repo: (room: string) => string, rules: (room: string) => ReturnType<typeof rulesOf>, self: () => Promise<string>}
const spaceOf = (locator: string, authRef: string): Space => {
  const {api, org} = space(locator), call = caller(api, authRef)
  const repo = (room: string) => `/repos/${org}/${encodeURIComponent(room)}`
  return {call, org, repo, rules: room => rulesOf(call, repo(room)),
    self: async () => (await call<{login: string}>('GET', '/user'))?.login ?? fail('Forgejo names no user for this token')}
}
// The operator's signals and the root's account are the root's: no grant or revocation touches them.
const notRoot = async (S: Space, actor: string, principal: string) => {
  if (actor === OPERATOR) fail('the operator\'s signals are the root\'s; they are neither granted nor revoked')
  if (principal === await S.self()) fail(`${principal} is the root's account; an actor writes through its own`)
}
// An actor writes through an account no other actor and not the root writes through.
const ownAccount = async (S: Space, room: string, actor: string, principal: string) => {
  await notRoot(S, actor, principal)
  const holder = Object.entries((await S.rules(room).effective(room)).signals).find(([a, p]) => p === principal && a !== actor)
  if (holder) fail(`${principal} already writes ${holder[0]}'s signals; each actor needs its own account`)
}
type Repo = {ssh_url: string, private: boolean}
// The room's repository, private and with the matrix's rules read back, before its address is handed to anyone.
const ensureRoom = async (S: Space, room: string) => {
  const found = await S.call<Repo>('GET', S.repo(room))
  if (found && !found.private) fail(`${S.org}/${room} exists on the forge and is public; ringi makes rooms in private repositories only`)
  if (!found) await S.call('POST', `/orgs/${S.org}/repos`, {name: room, private: true, auto_init: false, default_branch: 'main'})
  const r = S.rules(room), root = await S.self()
  await r.set('main', [root])
  if (!(await r.has('chat'))) await r.set('chat', [root])
  await r.set(signalsOf(OPERATOR), [root])
  await r.set('**', [])
  await r.closeTags(root)
  const repo = await S.call<Repo>('GET', S.repo(room)), now = await r.effective(room)
  if (!repo?.private || now.main.join() !== root || !now.chat.includes(root) || now.signals[OPERATOR] !== root)
    fail(`${S.org}/${room} on the forge is not private with main, chat and the operator's signals for ${root}`)
  return {address: typed(repo!.ssh_url)}
}
// What an account may do in a room's repository, as the forge reads it.
const permission = async (S: Space, room: string, principal: string) =>
  (await S.call<{permission: string}>('GET', `${S.repo(room)}/collaborators/${encodeURIComponent(principal)}/permission`))?.permission ?? 'none'
const grant = async (S: Space, room: string, actor: string, principal: string, key?: string) => {
  await ownAccount(S, room, actor, principal)
  if (key) await enrol(S.call, principal, key)
  await S.call('PUT', `${S.repo(room)}/collaborators/${encodeURIComponent(principal)}`, {permission: 'write'})
  const r = S.rules(room), chat = await r.pushers('chat')
  if (!chat.includes(principal)) await r.set('chat', [...chat, principal])
  await r.set(signalsOf(actor), [principal])
  if (!['write', 'admin', 'owner'].includes(await permission(S, room, principal))) fail(`${principal} cannot write ${S.org}/${room} on the forge after the grant`)
}
// Only the account the actor writes through is taken back, judged by the actor's own signals rule alone, so a
// revocation left half done is finished; any other account on it, or this one on another actor's, stops it before a
// change.
const revoke = async (S: Space, room: string, actor: string, principal: string) => {
  await notRoot(S, actor, principal)
  const r = S.rules(room), others = (await r.holders(principal)).filter(a => a !== actor)
  if (others.length) fail(`${principal} writes ${others.join(' and ')}'s signals in ${S.org}/${room}, not ${actor}'s; nothing is revoked`)
  const on = await r.named(signalsOf(actor)) ?? fail(`${signalsOf(actor)} in ${S.org}/${room} lets more than the accounts it names; nothing is revoked`)
  const wrong = on.filter(u => u !== principal)
  if (wrong.length) fail(`${actor} writes ${S.org}/${room} through ${wrong.join(', ')}, not ${principal}; nothing is revoked`)
  await r.drop(signalsOf(actor))
  await r.set('chat', (await r.pushers('chat')).filter(u => u !== principal))
  await S.call('DELETE', `${S.repo(room)}/collaborators/${encodeURIComponent(principal)}`)
  const left = [await r.has(signalsOf(actor)), (await r.pushers('chat')).includes(principal),
    ['write', 'admin', 'owner'].includes(await permission(S, room, principal))]
  if (left.some(Boolean)) fail(`${principal} still writes ${S.org}/${room} on the forge after the revocation`)
}

const forgejo = (locator: string, authRef: string): Access => {
  const S = spaceOf(locator, authRef)
  return {
    inspect: async () => ({version: (await S.call<{version: string}>('GET', '/version'))?.version ?? '?', principal: await S.self(),
      can: {actorBranches: true, privateRepos: true, deleteServer: true, refuseForcePush: true, accountKeys: true, deployKeys: false, hostKeysByApi: false}}),
    ownKey: async key => keyOn(S.call, {read: '/user/keys', write: '/user/keys', who: await S.self(), then: 'create the room again'}, key),
    ensureRoom: room => ensureRoom(S, room),
    account: login => account(S.call, login),
    accountKeys: a => accountKeys(S.call, a),
    grant: (room, actor, principal, key) => grant(S, room, actor, principal, key),
    revoke: (room, actor, principal) => revoke(S, room, actor, principal),
    effective: room => S.rules(room).effective(room),
    deleteServer: async room => {
      await S.call('DELETE', S.repo(room))
      if (await S.call('GET', S.repo(room))) fail(`${S.org}/${room} is still on the forge after deleting it`)
    },
  }
}
export const forgejoAccess: AccessType = forgejo
