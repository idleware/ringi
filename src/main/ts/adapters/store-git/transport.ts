// transport: an explicit contract source and one self-contained repository per room.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {fail} from '../../lib/index.ts'
import type {Descriptor, RoomEndpoint, Store, Transport} from '../../core/hub/ports/store.ts'
import {GitStore} from './index.ts'
import {init} from './repo.ts'
import type {Connection} from './repo.ts'
import type {SigningContext} from '../../core/signing/index.ts'
import type {TransportAuth} from './auth.ts'
import {identityKey} from './remote/keys.ts'
export type {TransportAuth, SshIdentity} from './auth.ts'
// Future E8 layout; the active gitTransport below still declares git/3 until the coordinated switch.
export const E8_GIT_LAYOUT = 'git/4'

export type Options = {signer?: SigningContext | (() => SigningContext), auth?: TransportAuth}
export const context = (d: {trust: string}, opt: Options) => d.trust === 'signed'
  ? (typeof opt.signer === 'function' ? opt.signer() : opt.signer) ?? fail('signed hubs require an injected Signer')
  : undefined
export const gitStore = (s: Store): GitStore => s instanceof GitStore ? s : fail('git contract copying requires a git source and target')
const fresh = (at: string, endpoint: RoomEndpoint, home: string): void => {
  const dir = path.join(at, endpoint.store.path, '.git')
  if (fs.existsSync(at)) fail('room directory already exists; retained for review')
  fs.mkdirSync(path.dirname(dir), {recursive: true, mode: 0o700})
  init(dir, home)
}
// All signing remains injected. Asserted construction never asks for a signer.
export const gitTransport = (home: string, opt: Options = {}): Transport => ({
  layout: 'git/3',
  identity: (d, who) => {
    const signing = context(d, opt) ?? fail('public identity requires a signed hub and injected Signer')
    const key = identityKey({name: d.name, signing}, who, true)
    return {publicKey: key.line, fingerprint: key.fp}
  },
  open: (at, d, endpoint) => new GitStore(at, d, home, {signing: context(d, opt), auth: opt.auth}, endpoint),
  create: (at, d, genesis) => {
    const signing = context(d, opt)
    if (signing) d.root = GitStore.rootFor(at, d, home, signing)
    const g = genesis(d)
    const store = GitStore.create(at, d, {home, signing, auth: opt.auth}, g.files, g.text)
    d.genesis = store.contractHead()
    return {store, custody: signing?.custody?.(d.name, 'operator') ?? null}
  },
  fork: (at, d, source, endpoint) => {
    const signing = context(d, opt)
    fresh(at, endpoint, home)
    const s = new GitStore(at, d, home, {signing, auth: opt.auth}, endpoint)
    s.seedContract(gitStore(source))
    return s
  },
  attachRoom: (at, d, endpoint) => attachRoom(at, d, endpoint, home, {signing: context(d, opt), auth: opt.auth}),
})
const attachRoom = (at: string, d: Descriptor, endpoint: RoomEndpoint, home: string, connection: Connection): Store => {
  if (d.trust !== 'signed' || !endpoint.store.remote) fail('remote room attachment requires signed trust and an explicit remote')
  if (fs.existsSync(at)) fail('room directory already exists; retained for review')
  const stage = `${at}.attach.${process.pid}.${crypto.randomBytes(8).toString('hex')}`
  try {
    fresh(stage, endpoint, home)
    const s = new GitStore(stage, d, home, connection, endpoint)
    s.sync()
    if (!s.room(endpoint.name)) fail('remote has no pinned chat')
    fs.renameSync(stage, at)
    return new GitStore(at, d, home, connection, endpoint)
  } finally { fs.rmSync(stage, {recursive: true, force: true}) }
}
