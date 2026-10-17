// Explicit git/4 transport. Creation consumes the exclusive directory witnessed by the location lifecycle.
import fs from 'node:fs'
import path from 'node:path'
import {fail} from '../../lib/index.ts'
import type {Descriptor, RoomEndpointV2, Store, TransportV4} from '../../core/hub/ports/store.ts'
import {checkEndpointV2} from '../../core/hub/rooms/endpoint-v2.ts'
import {canonical, check} from '../fs/directory.ts'
import {GitStore} from './index.ts'
import {init} from './repo.ts'
import {context, gitStore} from './transport.ts'
import type {Options} from './transport.ts'
import {identityKey} from './remote/keys.ts'
import {checkRepositoryPath} from './location.ts'
import {attachmentPhase, emptyAttachment, startAttachment} from './attachment.ts'

const endpointAt = (at: string, d: Descriptor, endpoint: RoomEndpointV2, creating = false): void => {
  checkEndpointV2(endpoint, d, {creating})
  if (endpoint.disposal) fail('room disposal is in progress; repository is retained')
  const directory = canonical(at), pinned = endpoint.location.directory
  if (directory?.path !== pinned.path || directory.identity !== pinned.identity) fail('selected repository directory changed its pinned object')
  if (endpoint.authRef && endpoint.authRef !== endpoint.keyRef) fail('SSH and signing require the same selected identity')
  check(pinned)
}
const preparedStore = (at: string, d: Descriptor, endpoint: RoomEndpointV2, home: string, creating: boolean): void => {
  endpointAt(at, d, endpoint, creating)
  if (endpoint.receipt || endpoint.disposal) fail('a prepared repository cannot claim earlier creation ownership')
  if (endpoint.store.path !== 'store') fail('new git/4 repositories require the explicit store child')
  if (fs.readdirSync(at).length) fail('prepared repository directory is not empty; retained without reuse or overwrite')
  fs.mkdirSync(path.join(at, 'store'), {mode: 0o700})
  init(path.join(at, 'store', '.git'), home)
  check(endpoint.location.directory)
}
const checkLocation = (at: string, d: Descriptor, endpoint: RoomEndpointV2): void => {endpointAt(at, d, endpoint); checkRepositoryPath(at, endpoint)}
const attachPrepared = (at: string, d: Descriptor, endpoint: RoomEndpointV2, home: string, opt: Options): GitStore => {
  if (d.trust !== 'signed' || !endpoint.store.remote) fail('attachment requires signed trust and an explicit remote')
  endpointAt(at, d, endpoint)
  if (endpoint.receipt) fail('attachment cannot claim a creation receipt')
  startAttachment(at, d, endpoint, () => preparedStore(at, d, endpoint, home, false))
  checkLocation(at, d, endpoint)
  const store = new GitStore(at, d, home, {signing: context(d, opt), auth: opt.auth, layout: 'git/4'}, endpoint)
  try {store.sync()} catch (error) {
    if ((error as {code?: string})?.code === 'denied' && emptyAttachment(at, endpoint)) attachmentPhase(at, d, endpoint, 'denied')
    throw error
  }
  if (!store.room(endpoint.name)) fail('attachment has no verified pinned room; partial repository is retained')
  check(endpoint.location.directory)
  attachmentPhase(at, d, endpoint, 'complete')
  return store
}
// No old layout is guessed. A preexisting repository can be adopted only after the caller proves its pins.
export const git4Transport = (home: string, opt: Options = {}): TransportV4 => {
  const connection = (d: Descriptor) => ({signing: context(d, opt), auth: opt.auth, layout: 'git/4' as const})
  const open = (at: string, d: Descriptor, endpoint?: RoomEndpointV2) => {
    if (endpoint) checkLocation(at, d, endpoint)
    return new GitStore(at, d, home, connection(d), endpoint)
  }
  return {layout: 'git/4', open, checkLocation,
    identity(d, who, endpoint) {
      if (endpoint) checkEndpointV2(endpoint, d)
      const signing = context(d, opt) ?? fail('asserted rooms have no signing identity')
      const key = identityKey({name: d.name, signing, endpoint, layout: 'git/4'}, who, true)
      return {publicKey: key.line, fingerprint: key.fp}
    },
    create(at, d, genesis) {
      const c = connection(d)
      if (c.signing) d.root = GitStore.rootFor(at, d, home, c.signing)
      const g = genesis(d), store = GitStore.create(at, d, {home, ...c}, g.files, g.text)
      d.genesis = store.contractHead()
      return {store, custody: c.signing?.custody?.(d.name, 'operator') ?? null}
    },
    fork(at, d, source: Store, endpoint) {
      const from = gitStore(source)
      if (from.h.layout !== 'git/4') fail('git/4 creation requires an explicit git/4 contract source')
      preparedStore(at, d, endpoint, home, true)
      const store = new GitStore(at, d, home, connection(d), endpoint)
      store.seedContract(from)
      return store
    },
    recoverPrepared(at, d, endpoint) {
      endpointAt(at, d, endpoint, true)
      checkRepositoryPath(at, endpoint)
      return new GitStore(at, d, home, connection(d), endpoint)
    },
    attachRoom(at, d, endpoint) {return attachPrepared(at, d, endpoint, home, opt)},
  }
}
