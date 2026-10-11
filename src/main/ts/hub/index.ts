// hub: hubs and rooms on top of any store. A hub is a directory with a descriptor (hub.json: which store, where,
// what this machine pins) beside its store. Its shared contract lives in the store (contract.json, authority.json,
// profiles/*.json). This file reads contracts, opens rooms with their profile and authority, and decides what a reader
// accepts: only history that extends what it accepted before, from members the store verifies (docs/spec/hub-1.md, Trust).

import fs from 'node:fs'
import path from 'node:path'
import * as D from '../domain/decisions.ts'
import {CAPABILITIES, unenforceable} from '../domain/index.ts'
import {GitStore} from '../store/git/index.ts'
import {HOME, OPERATOR, RESOURCES, VERSION, ensureHome, hubHome, hubsDir, locked, mkdir, writeJson} from '../home/index.ts'
import {DEFAULT_PROFILE, PROFILES_CAPABILITY, parseProfile} from '../domain/profiles.ts'
import type {Profile} from '../domain/profiles.ts'
import {HIDDEN, compose, decodeText, link, parse} from '../protocol/index.ts'
import type {All, FileRef, Message, Parsed} from '../protocol/index.ts'
import {emit} from './signals.ts'
import {STORES} from '../store/index.ts'
import type {Descriptor, Member, Rev, Store, StoredMessage, StoredRoom} from '../store/index.ts'
import {fail, short, strictJson} from '../lib/index.ts'
import type {Entry} from '../protocol/files.ts'

export const HUB_MAJOR = 1
export const CAPS = new Set(Object.keys(CAPABILITIES))
export const RESERVED_ROOMS = new Set(['main', 'archive'])

export type Contract = {
  schema: 'ringi-hub'
  version: string
  protocol: number
  trust: 'asserted' | 'signed'
  capabilities?: string[]
  // The profile rooms use unless they name another (profile.ts).
  profile?: string
  root?: string
  authority: D.Authority
}
export type Hub = {name: string, dir: string, d: Descriptor, store: Store, main: Rev, contract: Contract, signed: boolean}
export type Room = {
  hub: Hub
  s: StoredRoom
  name: string
  archived: boolean
  head: Rev
  genesis: Rev
  contractRev: Rev
  contract: Contract
  authorityAt: D.AuthorityAt
  profile: Profile
  members: Record<string, Member>
  // The quorum: how many agents (members besides the root) the room waits for before its work starts, or null.
  quorum: number | null
}
// Whether the room's work has started: it has the quorum of agents its genesis asked for (`Quorum`), or asked for none.
export const start = (R: Pick<Room, 'members' | 'quorum'>): {quorum: number | null, agents: number, started: boolean} => {
  const agents = Object.values(R.members).filter(m => m.role !== 'root').length
  return {quorum: R.quorum, agents, started: R.quorum === null || agents >= R.quorum}
}

// --- hubs ---

export const hubNames = (): string[] => {
  try { return fs.readdirSync(hubsDir()).filter(n => fs.existsSync(path.join(hubsDir(), n, 'hub.json'))).sort() } catch { return [] }
}
const HUB_MD = `# ringi hub

The shared contract of a ringi hub (docs/spec/hub-1.md): contract.json (schema, version, protocol, trust, capabilities, the
default profile), authority.json (who may decide what, up to which budget; the root, \`operator\`, always may) and
profiles/ (what a piece of work is in a room: its states, and who may move it). Use \`ringi\`; never edit by hand.
`
const readProfileResource = (name: string): string => fs.readFileSync(path.join(RESOURCES, 'profiles', `${name}.json`), 'utf8')
// A new hub: local (asserted senders), or signed, with the operator's root key generated on this machine and pinned.
export const createHub = (name: string, {signed = false, url}: {signed?: boolean, url?: string} = {}): void => {
  ensureHome()
  const dir = hubHome(name)
  if (fs.existsSync(dir)) fail(`hub ${name} exists`)
  if (url && !signed) fail('--url publishes a hub; only a --signed hub may be published')
  const d: Descriptor = {schema: 'ringi-hub/2', name, trust: signed ? 'signed' : 'asserted', store: {type: 'git', path: 'store', ...(url ? {remote: url} : {})}}
  try {
    mkdir(dir)
    if (signed) d.root = GitStore.rootFor(dir, d, HOME)
    const contract = {schema: 'ringi-hub', version: '1.1', protocol: 1, trust: d.trust, capabilities: [D.CAPABILITY, PROFILES_CAPABILITY], profile: DEFAULT_PROFILE, ...(d.root ? {root: d.root} : {})}
    const store = GitStore.create(dir, d, HOME, {
      'contract.json': JSON.stringify(contract, null, 2) + '\n',
      'authority.json': JSON.stringify({decide: {}}, null, 2) + '\n',
      'HUB.md': HUB_MD,
      [`profiles/${DEFAULT_PROFILE}.json`]: readProfileResource(DEFAULT_PROFILE),
    }, compose(`hub ${name}`, [['To', '*'], ['Kind', 'hub']]))
    if (signed) d.genesis = store.contractHead()
    writeJson(path.join(dir, 'hub.json'), d)
  } catch (e) {
    if (!fs.existsSync(path.join(dir, 'hub.json'))) fs.rmSync(dir, {recursive: true, force: true})
    throw e
  }
}
export const readDescriptor = (name: string): Descriptor => {
  const f = path.join(hubHome(name), 'hub.json')
  if (!fs.existsSync(f)) fail(`no hub ${name}; hubs: ${hubNames().join(', ') || 'none'}`)
  const d = strictJson<Descriptor>(fs.readFileSync(f, 'utf8'), f)
  if (d.schema !== 'ringi-hub/2' || d.name !== name || !['signed', 'asserted'].includes(d.trust) || !d.store?.type || !d.store.path) fail(`${f} is not a ringi hub descriptor this ringi ${VERSION} reads`)
  return d
}
// The contract a tool must understand before it touches a hub or a room: known schema, major and capabilities.
export const contractAt = (store: Store, name: string, rev: Rev): Contract => {
  const text = store.contractFile(rev, 'contract.json') ?? store.contractFile(rev, 'hub.json') ?? fail(`hub ${name} has no contract at ${short(rev)}`)
  const c = strictJson<Contract>(text, `hub ${name}: contract`)
  if (c.schema !== 'ringi-hub') fail(`hub ${name} declares schema ${String(c.schema)}, not ringi-hub`)
  const major = Number(String(c.version).split('.')[0])
  if (major !== HUB_MAJOR) fail(`hub ${name} follows contract version ${c.version}; this ringi ${VERSION} supports ${HUB_MAJOR}.x. Upgrade ringi`)
  const why = unenforceable(c.capabilities ?? [])
  if (why) fail(`hub ${name} ${why}, which this ringi ${VERSION} cannot enforce. Upgrade ringi`)
  const a = store.contractFile(rev, 'authority.json')
  return {...c, authority: a === null ? {} : strictJson<D.Authority>(a, `hub ${name}: authority.json at ${short(rev)}`)}
}
// A hub is opened once per process; its store syncs then (a signed store fetches and verifies), and again on refresh.
const opened = new Map<string, Hub>()
export const openHub = (name: string, {refresh = false}: {refresh?: boolean} = {}): Hub => {
  ensureHome()
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(name)) fail(`bad hub name ${name}`)
  if (opened.has(name) && !refresh) return opened.get(name)!
  if (name === 'local' && !fs.existsSync(path.join(hubHome(name), 'hub.json'))) createHub('local')
  const d = readDescriptor(name)
  const factory = STORES[d.store.type] ?? fail(`hub ${name} uses a ${d.store.type} store; this ringi ${VERSION} knows ${Object.keys(STORES).join(', ')}`)
  const store = factory(hubHome(name), d, HOME)
  store.sync()
  const main = store.contractHead()
  const H: Hub = {name, dir: hubHome(name), d, store, main, contract: contractAt(store, name, main), signed: d.trust === 'signed'}
  opened.set(name, H)
  return H
}

// --- rooms ---

export const roomNames = (H: Hub, archived = false): string[] => H.store.roomNames(archived)
export const openRoom = (H: Hub, name: string | null | undefined, {quiet = false}: {quiet?: boolean} = {}): Room | null => {
  if (!name) return fail('no room: the operator creates one with ringi room create <id>, or picks one with ringi room switch <id>')
  const s = H.store.room(name)
  if (!s) {
    if (quiet) return null
    const gone = roomNames(H, true).find(a => a.startsWith(`${name}@`))
    return fail(gone ? `room ${name} is archived as ${gone}; read it with --room ${gone}` : `no room ${name} in hub ${H.name}; rooms: ${roomNames(H).join(', ') || 'none'}`)
  }
  // The genesis names its room, in the root's hand: a history offered under another name is not that room.
  const named = s.archived ? name.slice(0, name.lastIndexOf('@')) : name
  const subject = s.control[0]?.rev === s.genesis ? s.control[0].text.split('\n')[0] : '(none)'
  if (subject !== `room ${named}` || (s.archived && name !== `${named}@${s.genesis.slice(0, 8)}`)) fail(`room ${name}: its genesis is "${subject}"; refusing a room's history under another name`)
  // The contract in effect at each control entry: the hub contract the room was created on, then each `Contract:`
  // the operator moved it to. A decision names the control entry it was made under (decide.ts).
  const atControl = new Map<Rev, Rev>()
  let current = s.base
  for (const rec of s.control) {
    const m = /^Contract: ([0-9a-f]{40,64})$/m.exec(rec.text)
    if (m) current = m[1]
    atControl.set(rec.rev, current)
  }
  const contract = current === H.main ? H.contract : contractAt(H.store, H.name, current)
  const tables = new Map<Rev, D.Authority>()
  const authorityAt: D.AuthorityAt = (control) => {
    const rev = control ? atControl.get(control) : undefined
    if (!rev) return null
    if (!tables.has(rev)) tables.set(rev, contractAt(H.store, H.name, rev).authority)
    return tables.get(rev)!
  }
  // The room's profile is fixed when the room is made: its content is copied into the genesis control entry, so no
  // later change of the hub's profiles or contract reinterprets the room's history. Rooms made before this carry
  // none and use the default profile of the contract they were created on.
  const baseProfile = contractAt(H.store, H.name, s.base).profile ?? DEFAULT_PROFILE
  const profileText = H.store.controlFile(s, 'profile.json', s.genesis)
    ?? H.store.contractFile(s.base, `profiles/${baseProfile}.json`)
    ?? (baseProfile === DEFAULT_PROFILE ? readProfileResource(DEFAULT_PROFILE) : fail(`room ${name}: unknown profile ${baseProfile}`))
  const roster = H.store.roster(s)
  const members = roster?.members ?? strictJson<Record<string, Member>>(H.store.controlFile(s, 'members.json') ?? '{}', `room ${name}: members.json`)
  // The root's control records set the quorum; the latest one counts.
  let quorum: number | null = null
  for (const rec of s.control) {
    const m = /^Quorum: ([1-9][0-9]?)$/m.exec(rec.text)
    if (m) quorum = Number(m[1])
  }
  return {hub: H, s, name, archived: s.archived, head: s.head, genesis: s.genesis, contractRev: current, contract, authorityAt,
    profile: parseProfile(profileText, `room ${name}: profile`), members, quorum}
}
export const room = (H: Hub, name: string | null | undefined): Room => openRoom(H, name)!
export const ROOM_MD = (name: string): string => `# room ${name}\n\nA ringi room: members.json lists who takes part; profile.json is what a piece of work is here, fixed when the room was made.\n`
export const profileText = (H: Hub, name: string): string | null =>
  H.store.contractFile(H.main, `profiles/${name}.json`) ?? (name === DEFAULT_PROFILE ? readProfileResource(DEFAULT_PROFILE) : null)
// A control change under the hub lock. In a signed room membership changes only through `room admit`.
export const controlChange = (R: Room, who: string, subject: string, mutate: (m: Record<string, Member>) => void, extra: Array<[string, string]> = []): void =>
  locked(`hub-${R.hub.name}`, () => {
    const s = R.hub.store.room(R.name) ?? fail(`room ${R.name} is gone`)
    const members = strictJson<Record<string, Member>>(R.hub.store.controlFile(s, 'members.json') ?? '{}', `room ${R.name}: members.json`)
    const before = JSON.stringify(members)
    mutate(members)
    if (R.hub.signed && JSON.stringify(members) !== before) fail('in a signed room, membership changes only by ringi room admit')
    R.head = R.hub.store.updateControl(s, who, compose(subject, [['To', '*'], ['Kind', 'room'], ...extra]), {'members.json': JSON.stringify(members, null, 2) + '\n'})
    R.members = members
  })

// --- messages and what a reader accepts ---

export const toMessage = (R: Room, from: string, x: StoredMessage, seq: number): Message => {
  const trust = R.hub.signed ? 'verified' : 'asserted'
  const files: FileRef[] = x.files.map(f => ({path: f.path, size: null}))
  const base = {id: x.id, from, trust, time: x.time, seq, files, refused: x.refused, reId: null, hopEff: 0} as const
  const d = decodeText(x.text)
  if (d.invalid !== undefined) {
    return {...base, invalid: d.invalid, subject: '', body: '', to: [], re: null, kind: null, state: null, assign: null, roles: null, hop: 0, bad: d.invalid, trailers: {}}
  }
  const p: Parsed = parse(d.text!, s => R.hub.store.isRef(s))
  // An extension's trailers and the room profile's states are part of a message's validity.
  const ext = D.check(p, s => R.hub.store.isRef(s))
  const state = !p.bad && p.state && !R.profile.states.includes(p.state) ? `State ${p.state} is not in profile ${R.profile.name}` : null
  return {...base, invalid: null, ...p, bad: p.bad ?? ext ?? state}
}
// The room as stored, read without a reader's lock or state: for an author working out the signals of its own message
// (append runs inside reader locks too). Readers check signals themselves.
export const asStored = (R: Room): All => {
  const s = R.hub.store.room(R.name) ?? R.s
  return link(new Map(R.hub.store.logIds(s).map(id => [id, R.hub.store.messages(s, id, R.hub.store.logHead(s, id)!).map((x, seq) => toMessage(R, id, x, seq))])))
}
const CARRIES = (p: Parsed, R: Room) => !p.bad && (p.kind === R.profile.opens || !!p.assign || !!p.state || ['proposal', 'stamp', 'decision', 'usage'].includes(p.kind ?? ''))
// A message on the author's log, and the signals it made (signals.ts).
export const append = (R: Room, who: string, text: string, entries: Entry[] = []): Rev => {
  const id = R.hub.store.append(R.s, who, text, entries)
  if (CARRIES(parse(text, s => R.hub.store.isRef(s)), R)) {
    const all = asStored(R)
    const m = all.get(id)
    if (m) emit(R, who, all, m)
  }
  return id
}
export const withSizes = (R: Room, m: Message): FileRef[] => {
  if (!m.files.length) return []
  const sizes = R.hub.store.sizes(m.id, m.files.map(f => f.path))
  return m.files.map(f => ({...f, size: sizes.get(f.path) ?? null}))
}
export const pongText = (me: string, m: Message, what: string): string => compose(`pong: ${me} ${what}`, [['To', m.from], ['Re', m.id], ['Kind', 'pong'], ['Hop', String(m.hopEff + 1)]])
export {OPERATOR, HIDDEN}
