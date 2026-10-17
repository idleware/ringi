// room-create: a new room at an address: a local one in the home or at a path of the operator's, or one in a space on
// a forge, made private there with the accounts it invites; and inviting one more account later.

import crypto from 'node:crypto'
import path from 'node:path'
import {DEFAULT_PROFILE, parseProfile} from '../work/index.ts'
import {hubPorts} from '../ports/index.ts'
import {OPERATOR, ROOM_MD, createRegisteredRoom, openContract, openHub, profileText, provisionedRepository, repositoryIntent, setConfig} from '../rooms/index.ts'
import type {Hub, RoomCreationSpec, RoomV2} from '../rooms/index.ts'
import {canonical, parseAddress} from '../rooms/address.ts'
import type {RemoteSpace, RoomAddress} from '../rooms/address.ts'
import type {RoomRegistration} from '../rooms/room-catalogue.ts'
import {fail} from '../../../lib/index.ts'
import {accessOf, ownKey, realmOf, spaceHub, spaceOf} from './access.ts'
import type {SpaceInput} from './access.ts'
import {allInvited, inviteInto, invitePlanned, planInvites} from './membership.ts'
import type {Planned} from './membership.ts'
import {inviteLine} from './invite.ts'
import {active, catalogue, transportOfHub} from './rooms.ts'

export type CreateInput = SpaceInput & {profile?: string, quorum?: number, invite?: string[]}
export type Invited = {actor: string, login: string, line: string}
export type Created = {R: RoomV2, profile: string, invites: Invited[]}
const randomName = () => `room-${crypto.randomBytes(3).toString('hex')}`
// The files a room starts with: its profile, fixed from now on whatever the hub's profiles become; its roster, the root
// alone; and on a signed hub who may sign, the root first.
const startFiles = (H: Hub, name: string, profile?: string) => {
  const {store, main, contract} = openContract(H)
  const p = profile ?? contract.profile ?? DEFAULT_PROFILE
  const text = profileText(H, p) ?? fail(`this hub carries no profile ${p}; add it with ringi hub amend -m "<why>" --attach <file>:profiles/${p}.json`)
  parseProfile(text, `profile ${p}`)
  const files: Record<string, string> = {'ROOM.md': ROOM_MD(name), 'members.json': JSON.stringify({members: {[OPERATOR]: {role: 'root'}}, retired: {}}, null, 2) + '\n', 'profile.json': text}
  if (H.signed) files.allowed_signers = store.rootRoster?.() ?? fail('this hub\'s store cannot start a signed roster')
  return {profile: p, contract: main, files}
}
type Plan = {H: Hub, address: string, name: string, target: (id: string) => string, spec: RoomCreationSpec, invitees: Planned[]}
// The durable intent first: a create that stopped half way, even after its room was made, is finished by running it
// again with the same address and options, which name the same operation; one that finished says the room exists.
const reserve = (p: Plan): RoomRegistration => {
  const operation = crypto.createHash('sha256').update(`create ${p.address}`).digest('hex').slice(0, 32)
  const old = catalogue().all().find(r => r.address === p.address)
  if (old && active(old) && (old.reservation?.operation !== operation || allInvited(old.id, p.invitees))) fail(`room ${p.address} exists; ringi room switch ${p.address}`)
  return catalogue().reserve({owner: {name: p.H.d.name, genesis: p.H.d.genesis, trust: p.H.d.trust, ...(p.H.d.root ? {root: p.H.d.root} : {})},
    operation, parameters: {repository: repositoryIntent(p.spec), invitees: p.invitees}},
  () => ({address: p.address, name: p.name, generation: crypto.randomBytes(16).toString('hex')}))
}
// Then the repository, from the reserved intent as the provider completed it; and it becomes the current room.
const build = (p: Plan, r: RoomRegistration, spec: RoomCreationSpec): RoomV2 => {
  const R = createRegisteredRoom(p.H, r.id, p.target(r.id), transportOfHub(p.H), spec)
  setConfig({room: R.endpoint.address})
  return R
}
const again = (address: string) => (e: Error): never => fail(`${e.message}; run ringi room create ${address} again to finish it`)
// The root key on its account, the private repository there, its locator bound to the reservation, then the room.
const provisioned = async (p: Plan, r: RoomRegistration, access: NonNullable<ReturnType<typeof accessOf>>): Promise<RoomV2> => {
  await ownKey(p.H)
  const {address: remote} = await access.ensureRoom(p.name)
  catalogue().bindRemote(r.id, remote)
  return build(p, r, provisionedRepository(p.spec, remote))
}
const quorumOk = (q?: number): void => {
  if (q !== undefined && !(Number.isSafeInteger(q) && q >= 1 && q <= 99)) fail('--quorum takes a number of agents, 1 to 99')
}
// A local room, in the home's room directory or where its path says; its agents join it by name, on this machine.
const createLocal = (a: Extract<RoomAddress, {kind: 'local' | 'path'}>, x: CreateInput): Created => {
  if (x.invite?.length) fail('--invite is for a room in a space; agents on this machine join a local room by its name')
  if (x.tokenFile || x.hostKeyFile) fail('--token-file and --host-key-file are for the first room in a space')
  const H = openHub('local'), name = a.kind === 'local' ? a.room : path.basename(a.path)
  const start = startFiles(H, name, x.profile)
  const target = () => a.kind === 'local' ? path.join(hubPorts().state.place(['rooms']), a.room) : a.path
  const p: Plan = {H, address: canonical(a), name, target, invitees: [], spec: {contract: start.contract, files: start.files, ...(x.quorum ? {quorum: x.quorum} : {})}}
  return {R: build(p, reserve(p), p.spec), profile: start.profile, invites: []}
}
// A room in a space: the invitees' accounts and the token checked first, then the private repository on the forge,
// then the room; each invitee gets the line its machine joins by, and the root admits the key it puts on its account.
const createInSpace = async (a: Extract<RoomAddress, {kind: 'remote'}> | RemoteSpace, x: CreateInput): Promise<Created> => {
  const space = spaceOf(a), H = await spaceHub(space, x), access = accessOf(H)!
  const name = a.kind === 'remote' ? a.room : randomName()
  const address = canonical({kind: 'remote', provider: a.provider, host: a.host, port: a.port, space: a.space, room: name})
  const invitees = await planInvites(access, realmOf(space), address, x.invite ?? [])
  const start = startFiles(H, name, x.profile)
  // Over SSH the root's own key reaches it, the host's keys pinned; another transport (a local file) needs neither.
  const root = `ringi-key:${H.name}/${OPERATOR}`, reach = {keyRef: root, authRef: root, hostKeys: H.d.access!.hostKeys}
  const p: Plan = {H, address, name, target: id => path.join(hubPorts().state.place(['clones']), id), invitees,
    spec: {contract: start.contract, files: start.files, reach, ...(x.quorum ? {quorum: x.quorum} : {})}}
  // The repository on the forge only once the room is reserved here, so a retry finds the same one.
  const r = reserve(p)
  // Whatever fails from here on is finished by running the same create again: the error says with which address.
  const finish = async (): Promise<Created> => {
    const R = await provisioned(p, r, access)
    const invites = invitePlanned(R, realmOf(space), invitees).map(e => ({actor: e.actor, login: 'login' in e.principal ? e.principal.login : e.actor, line: inviteLine(R, e)}))
    return {R, profile: start.profile, invites}
  }
  return finish().catch(again(address))
}
export const create = async (input: string | undefined, x: CreateInput = {}): Promise<Created> => {
  hubPorts().state.ensure()
  quorumOk(x.quorum)
  const a = parseAddress(input ?? randomName(), 'create')
  return a.kind === 'local' || a.kind === 'path' ? createLocal(a, x) : createInSpace(a, x)
}
// An account invited into a room in a space: the root's list gives it the next actor id, and the line says the rest.
export const invite = async (R: RoomV2, login: string): Promise<Invited> => {
  const space = R.hub.d.access?.address ?? fail(`room ${R.endpoint.address} is not in a space; agents on this machine join it by name`)
  const e = await inviteInto(R, {mode: 'account', realm: realmOf(space), who: login, invitation: crypto.randomBytes(8).toString('hex')})
  return {actor: e.actor, login, line: inviteLine(R, e)}
}
