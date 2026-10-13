// transport: an explicit contract source and one self-contained repository per room.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {fail} from '../../lib/index.ts'
import type {Descriptor, RoomEndpoint, Store, Transport} from '../../core/hub/ports/store.ts'
import {GitStore} from './index.ts'
import {init} from './repo.ts'
import type {SigningContext} from '../../core/signing/index.ts'

type Options = {signer?: SigningContext | (() => SigningContext)}
const context = (d: {trust: string}, opt: Options) => d.trust === 'signed'
  ? (typeof opt.signer === 'function' ? opt.signer() : opt.signer) ?? fail('signed hubs require an injected Signer')
  : undefined
const gitStore = (s: Store): GitStore => s instanceof GitStore ? s : fail('git contract copying requires a git source and target')
const fresh = (at: string, endpoint: RoomEndpoint, home: string): void => {
  const dir = path.join(at, endpoint.store.path, '.git')
  if (fs.existsSync(at)) fail('room directory already exists; retained for review')
  fs.mkdirSync(path.dirname(dir), {recursive: true, mode: 0o700})
  init(dir, home)
}
// All signing remains injected. Asserted construction never asks for a signer.
export const gitTransport = (home: string, opt: Options = {}): Transport => ({
  layout: 'git/3',
  open: (at, d, endpoint) => new GitStore(at, d, home, context(d, opt), endpoint),
  create: (at, d, genesis) => {
    const signing = context(d, opt)
    if (signing) d.root = GitStore.rootFor(at, d, home, signing)
    const g = genesis(d)
    const store = GitStore.create(at, d, {home, signing}, g.files, g.text)
    d.genesis = store.contractHead()
    return {store, custody: signing?.custody?.(d.name, 'operator') ?? null}
  },
  fork: (at, d, source, endpoint) => {
    const signing = context(d, opt)
    fresh(at, endpoint, home)
    const s = new GitStore(at, d, home, signing, endpoint)
    s.seedContract(gitStore(source))
    return s
  },
  attachRoom: (at, d, endpoint) => attachRoom(at, d, endpoint, home, context(d, opt)),
})
const attachRoom = (at: string, d: Descriptor, endpoint: RoomEndpoint, home: string, signing?: SigningContext): Store => {
  if (d.trust !== 'signed' || !endpoint.store.remote) fail('remote room attachment requires signed trust and an explicit remote')
  if (fs.existsSync(at)) fail('room directory already exists; retained for review')
  const stage = `${at}.attach.${process.pid}.${crypto.randomBytes(8).toString('hex')}`
  try {
    fresh(stage, endpoint, home)
    const s = new GitStore(stage, d, home, signing, endpoint)
    s.sync()
    if (!s.room(endpoint.name)) fail('remote has no pinned chat')
    fs.renameSync(stage, at)
    return new GitStore(at, d, home, signing, endpoint)
  } finally { fs.rmSync(stage, {recursive: true, force: true}) }
}
