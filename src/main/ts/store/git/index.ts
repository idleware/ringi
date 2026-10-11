// git-store: the Store port on git. The store directory holds one bare repository (`store/.git`):
//   refs/heads/main                       the shared contract, one commit per amendment
//   refs/heads/<room>/control             the room's control record; its first commit is the room's genesis
//   refs/heads/<room>/log/<agent>         one log per member; each message is a commit
//   refs/tags/ringi/<genesis>/<agent>/<message>.<signal>   signals, annotated tags in their author's namespace
//   refs/archive/<room>@<genesis8>/…      an archived room, read-only
//   refs/ringi/accepted/<genesis>/<reader>/<log>   readers' pins of accepted heads
// A signed hub signs every commit and tag with its author's key and verifies what it fetches (remote.ts).

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {spawnSync} from 'node:child_process'
import type {SpawnSyncReturns} from 'node:child_process'
import {cannotWrite, mkdirIn, SANDBOX} from '../../lib/index.ts'
import * as Remote from './remote.ts'
import type {Descriptor, JoinKey, Roster, SignalRecord, Store, StoredMessage, StoredRoom} from '../index.ts'
import {fail, note} from '../../lib/index.ts'
import {TEXT_MAX, checkOutgoing, parse} from '../../protocol/index.ts'
import {checkCollisions, checkPath} from '../../protocol/files.ts'
import type {Entry} from '../../protocol/files.ts'

const ZERO = '0'.repeat(40)
const ident = (id: string) => ({GIT_AUTHOR_NAME: id, GIT_AUTHOR_EMAIL: `${id}@ringi`, GIT_COMMITTER_NAME: id, GIT_COMMITTER_EMAIL: `${id}@ringi`})
// `where`: the directory to name when a sandbox refuses a write (the ringi home).
type GitOpt = {input?: string | Buffer, env?: Record<string, string>, where?: string}

export const runGit = (args: string[], o: GitOpt = {}): string => {
  const r = spawnSync('git', args, {input: o.input, encoding: 'utf8', env: Remote.gitEnv(o.env), maxBuffer: 1 << 30, timeout: Remote.gitTimeout()})
  return check(args, r, o.where).stdout
}
const runGitOk = (args: string[], o: GitOpt = {}): SpawnSyncReturns<string> => {
  const r = spawnSync('git', args, {input: o.input, encoding: 'utf8', env: Remote.gitEnv(o.env), maxBuffer: 1 << 30, timeout: Remote.gitTimeout()})
  Remote.checkGitTimeout(r.error)
  return r
}
const runGitRaw = (args: string[], where?: string): Buffer => {
  const r = spawnSync('git', args, {encoding: 'buffer', env: Remote.gitEnv(), maxBuffer: 1 << 30, timeout: Remote.gitTimeout()})
  return check(args, r, where).stdout
}
function check<T extends string | Buffer>(args: string[], r: SpawnSyncReturns<T>, where = 'the hub store'): SpawnSyncReturns<T> {
  Remote.checkGitTimeout(r.error)
  if (r.error) throw r.error
  if (r.status !== 0) {
    const err = String(r.stderr ?? '').trim()
    if (SANDBOX.test(err)) cannotWrite(where, err.split('\n').at(-1)!)
    fail(`git ${args.find(a => !a.startsWith('-') && !a.includes('/')) ?? ''}: ${err.split('\n').at(-1)}`)
  }
  return r
}
const splitBuf = (b: Buffer, sep: number): Buffer[] => {
  const parts: Buffer[] = []
  let at = 0
  for (let i = b.indexOf(sep); i >= 0; i = b.indexOf(sep, at)) {
    parts.push(b.subarray(at, i))
    at = i + 1
  }
  parts.push(b.subarray(at))
  return parts
}
const REGULAR = new Set(['100644', '100755'])

export class GitStore implements Store {
  readonly type = 'git'
  readonly trust: 'asserted' | 'signed'
  readonly dir: string
  readonly d: Descriptor
  readonly home: string
  // The handle remote.ts works on: the repository and what it learned on the last sync.
  readonly h: Remote.Handle

  constructor(hubDir: string, d: Descriptor, home: string) {
    this.d = d
    this.home = home
    this.trust = d.trust
    this.dir = path.join(hubDir, d.store.path, '.git')
    this.h = {name: d.name, dir: this.dir, d}
    if (!fs.existsSync(this.dir)) fail(`hub ${d.name}: no git store at ${this.dir}`)
  }
  private args(a: string[]) { return ['--git-dir', this.dir, ...a] }
  private git(a: string[], o?: GitOpt) { return runGit(this.args(a), {...o, where: this.home}) }
  private gitOk(a: string[], o?: GitOpt) { return runGitOk(this.args(a), o) }
  rev(ref: string): string | null {
    const r = this.gitOk(['rev-parse', '-q', '--verify', `${ref}^{commit}`])
    return r.status === 0 ? r.stdout.trim() : null
  }
  isAncestor(a: string, b: string): boolean { return this.gitOk(['merge-base', '--is-ancestor', a, b]).status === 0 }
  isRef(s: string): boolean { return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(s ?? '') }
  extends(older: string, newer: string): boolean { return older === newer || this.isAncestor(older, newer) }

  // --- writing ---

  private emptyTree() { return this.git(['hash-object', '-w', '-t', 'tree', '--stdin'], {input: ''}).trim() }
  // A tree from a base tree with entries put on top; nested paths are fine.
  private tree(base: string | null, entries: Entry[]): string {
    const idx = path.join(this.home, 'tmp', `index.${process.pid}.${crypto.randomBytes(4).toString('hex')}`)
    mkdirIn(this.home, path.dirname(idx))
    const env = {GIT_INDEX_FILE: idx}
    try {
      this.git(['read-tree', ...(base ? [base] : ['--empty'])], {env})
      for (const e of entries) {
        const sha = this.git(['hash-object', '-w', ...(e.file ? ['--', e.file] : ['--stdin'])], {input: e.content}).trim()
        this.git(['update-index', '--add', '--cacheinfo', `${e.mode},${sha},${e.path}`], {env})
      }
      return this.git(['write-tree'], {env}).trim()
    } finally {
      fs.rmSync(idx, {force: true})
    }
  }
  // Every commit is made here: on a signed hub, signed by its author's key on this machine.
  private commit(who: string, text: string, tree: string, parents: string[]): string {
    return this.git(['commit-tree', ...Remote.sign(this.h, who, this.home), tree, ...parents.flatMap(p => ['-p', p])], {input: text, env: ident(who)}).trim()
  }
  private advance(ref: string, sha: string, old: string | null): boolean {
    if (this.gitOk(['update-ref', ref, sha, old ?? ZERO]).status !== 0) return false
    // A signed hub publishes at once; a rejected push keeps the commit here and alarms (remote.ts).
    Remote.push(this.h, ref)
    return true
  }
  static create(hubDir: string, d: Descriptor, home: string, contract: Record<string, string>, text: string): GitStore {
    const dir = path.join(hubDir, d.store.path, '.git')
    // A signed hub's repository already exists: rootFor made it with the root key.
    if (!fs.existsSync(dir)) {
      mkdirIn(home, path.dirname(dir))
      runGit(['init', '--bare', '-q', '-b', 'main', dir], {where: home})
    }
    const s = new GitStore(hubDir, d, home)
    const sha = s.commit('operator', text, s.tree(null, Object.entries(contract).map(([p, c]) => ({path: p, content: c, mode: '100644'}))), [])
    if (d.trust === 'signed') d.genesis = sha
    if (!s.advance('refs/heads/main', sha, null)) fail(`hub ${d.name}: main already exists`)
    return s
  }
  // A new signed hub: the root key is generated on this machine and pinned in the descriptor.
  static rootFor(hubDir: string, d: Descriptor, home: string): string {
    const dir = path.join(hubDir, d.store.path, '.git')
    mkdirIn(home, path.dirname(dir))
    runGit(['init', '--bare', '-q', '-b', 'main', dir], {where: home})
    return Remote.setupSigned({name: d.name, dir, d}, home, d.store.remote).root
  }

  sync(): void {
    Remote.sync(this.h)
  }

  // --- the contract ---

  contractHead(): string { return this.rev('refs/heads/main') ?? fail(`hub ${this.d.name} has no contract (main)`) }
  contractFile(rev: string, name: string): string | null {
    const r = this.gitOk(['show', `${rev}:${name}`])
    return r.status === 0 ? r.stdout : null
  }
  contractFiles(rev: string): string[] { return this.git(['ls-tree', '-r', '--name-only', rev]).split('\n').filter(Boolean) }
  amendContract(who: string, text: string, files: Record<string, string | Buffer>): string {
    const head = this.contractHead()
    const sha = this.commit(who, text, this.tree(`${head}^{tree}`, Object.entries(files).map(([p, c]) => ({path: p, content: c as string, mode: '100644'}))), [head])
    if (!this.advance('refs/heads/main', sha, head)) fail('the contract moved while amending; retry')
    return sha
  }

  // --- rooms ---

  private base(name: string) { return name.includes('@') ? `refs/archive/${name}` : `refs/heads/${name}` }
  roomNames(archived: boolean): string[] {
    const re = archived ? /^refs\/archive\/([^/]+)\/control$/ : /^refs\/heads\/([^/]+)\/control$/
    return this.git(['for-each-ref', '--format=%(refname)', archived ? 'refs/archive/' : 'refs/heads/']).split('\n').map(r => re.exec(r)?.[1]).filter((x): x is string => !!x).sort()
  }
  room(name: string): StoredRoom | null {
    const control = `${this.base(name)}/control`
    const head = this.rev(control)
    if (!head) return null
    const genesis = this.git(['rev-list', '--reverse', control, '^refs/heads/main']).split('\n')[0]
      || this.git(['rev-list', '--reverse', control]).split('\n').filter(Boolean).at(-1)!
    const recs = this.git(['log', '--reverse', '--format=%H%x1f%B%x1e', control, `^${genesis}^`]).split('\x1e').map(s => s.trim()).filter(Boolean)
    return {name, archived: name.includes('@'), head, genesis, base: this.git(['rev-parse', `${genesis}^`]).trim(),
      control: recs.map(r => {
        const [rev, text = ''] = r.split('\x1f')
        return {rev: rev.trim(), text}
      })}
  }
  controlFile(room: StoredRoom, name: string, rev?: string): string | null {
    const r = this.gitOk(['show', `${rev ?? room.head}:${name}`])
    return r.status === 0 ? r.stdout : null
  }
  createRoom(name: string, who: string, text: string, files: Record<string, string>): string {
    const ref = `refs/heads/${name}/control`
    if (this.rev(ref)) fail(`room ${name} exists in hub ${this.d.name}`)
    const sha = this.commit(who, text, this.tree(null, Object.entries(files).map(([p, c]) => ({path: p, content: c, mode: '100644'}))), [this.contractHead()])
    if (!this.advance(ref, sha, null)) fail(`room ${name} was created meanwhile`)
    return sha
  }
  // Every other file of the control tree (a signed room's allowed_signers) is kept.
  updateControl(room: StoredRoom, who: string, text: string, files: Record<string, string>): string {
    const ref = `${this.base(room.name)}/control`
    const sha = this.commit(who, text, this.tree(`${room.head}^{tree}`, Object.entries(files).map(([p, c]) => ({path: p, content: c, mode: '100644'}))), [room.head])
    if (!this.advance(ref, sha, room.head)) fail(`room ${room.name}: its control moved; retry`)
    return sha
  }
  private refsUnder(prefix: string): Array<[string, string]> {
    return this.git(['for-each-ref', '--format=%(refname) %(objectname)', prefix]).split('\n').filter(Boolean).map(l => l.split(' ') as [string, string])
  }
  archiveRoom(room: StoredRoom, as: string): void {
    const moves: Array<[string, string]> = [[`${this.base(room.name)}/`, `refs/archive/${as}/`], [`refs/tags/ringi/${room.genesis}/`, `refs/archive/${as}/signals/`]]
    for (const [from, to] of moves) {
      for (const [ref, sha] of this.refsUnder(from)) {
        this.git(['update-ref', `${to}${ref.slice(from.length)}`, sha, ZERO])
        this.git(['update-ref', '-d', ref, sha])
      }
    }
  }
  deleteRoom(room: StoredRoom): void {
    for (const prefix of [`${this.base(room.name)}/`, `refs/ringi/accepted/${room.genesis}/`, `refs/tags/ringi/${room.genesis}/`]) {
      for (const [ref] of this.refsUnder(prefix)) this.git(['update-ref', '-d', ref])
    }
  }
  private legacy(room: StoredRoom) {
    const base = this.base(room.name)
    return {name: room.name, head: room.head, genesis: room.genesis, archived: room.archived, control: `${base}/control`, log: (who: string) => `${base}/log/${who}`}
  }
  roster(room: StoredRoom): Roster | null {
    if (this.trust !== 'signed' || room.archived) return null
    const v = Remote.verifyRoom(this.h, this.legacy(room))
    return {members: v.members, signers: v.entries}
  }

  // --- logs ---

  logIds(room: StoredRoom): string[] {
    const prefix = `${this.base(room.name)}/log/`
    return this.git(['for-each-ref', '--format=%(refname)', prefix]).split('\n').filter(Boolean).map(r => r.slice(prefix.length))
  }
  logHead(room: StoredRoom, id: string): string | null { return this.rev(`${this.base(room.name)}/log/${id}`) }
  // The log's commits after the genesis, oldest first, read as bytes: the text is the commit message, the files are
  // the explicit Ringi-Files list, or the changed paths for records without it.
  messages(room: StoredRoom, id: string, head: string): StoredMessage[] {
    const raw = runGitRaw(this.args(['log', '--topo-order', '--reverse', '--no-renames', '--raw', '--no-abbrev', '--format=%x1e%H%x1f%P%x1f%ct%x1f%B%x1f', head, `^${room.genesis}`]), this.home)
    return splitBuf(raw, 0x1e).filter(b => b.length).map(rec => {
      const [sha, parent, ct, body, rest = Buffer.alloc(0)] = splitBuf(rec, 0x1f)
      let files = rest.toString('utf8').split('\n').map(l => /^:\d{6} (\d{6}) \S+ \S+ ([A-Z])\d*\t(.*)$/.exec(l)).filter((x): x is RegExpExecArray => !!x)
        .filter(([, , status]) => status !== 'D').map(([, mode, , p]) => ({path: p, mode}))
      const declared = parse(body.toString('utf8'), s => this.isRef(s)).trailers['ringi-files']
      const refused: StoredMessage['refused'] = []
      if (declared) {
        let names: string[] = []
        try {
          const paths: unknown = JSON.parse(declared[0])
          if (declared.length !== 1 || !Array.isArray(paths) || !paths.every(p => typeof p === 'string')) fail('invalid attachment list')
          names = (paths as string[]).map(checkPath)
          if (new Set(names).size !== names.length) fail('duplicate attachment path')
          checkCollisions(names)
        } catch {
          refused.push({path: 'Ringi-Files', mode: 'invalid', why: 'expected one JSON array of safe, distinct file paths'})
        }
        const wanted = new Set(names)
        files = names.length && !refused.length ? splitBuf(runGitRaw(this.args(['ls-tree', '-r', '-z', sha.toString()]), this.home), 0)
          .map(b => /^(\d+) \w+ [0-9a-f]+\t(.*)$/s.exec(b.toString('utf8'))).filter((x): x is RegExpExecArray => !!x)
          .map(([, mode, p]) => ({path: p, mode})).filter(f => wanted.has(f.path)) : []
        for (const f of files) wanted.delete(f.path)
        if (!refused.length) for (const p of wanted) files.push({path: p, mode: 'missing'})
      }
      return {id: sha.toString(), parent: parent.toString() || null, time: Number(ct.toString()), text: body,
        files: files.filter(f => REGULAR.has(f.mode)), refused: [...refused, ...files.filter(f => !REGULAR.has(f.mode))]}
    })
  }
  // One commit on the author's log, compare-and-swap, so two writers of one log retry instead of forking it.
  append(room: StoredRoom, who: string, text: string, entries: Entry[]): string {
    if (room.archived) fail(`room ${room.name} is archived: read-only`)
    if (checkOutgoing(text, s => this.isRef(s)).trailers['ringi-files']) fail('Ringi-Files is store metadata; supply attachments instead')
    if (entries.length) text = `${text.trimEnd()}\nRingi-Files: ${JSON.stringify([...new Set(entries.map(e => e.path))])}\n`
    if (Buffer.byteLength(text) > TEXT_MAX) fail('attachment list makes the message exceed 64 KiB; use fewer or shorter paths')
    checkOutgoing(text, s => this.isRef(s))
    const ref = `${this.base(room.name)}/log/${who}`
    for (let i = 0; i < 8; i++) {
      const head = this.rev(ref)
      const base = head ? `${head}^{tree}` : null
      const tree = entries.length ? this.tree(base, entries) : base ? this.git(['rev-parse', base]).trim() : this.emptyTree()
      const sha = this.commit(who, text, tree, [head ?? room.genesis])
      if (this.advance(ref, sha, head)) return sha
    }
    return fail(`the log ${who} kept moving while writing; retry`)
  }
  verifyLog(room: StoredRoom, id: string, head: string): string | null {
    return this.trust === 'signed' ? Remote.verify(this.h, this.legacy(room), id, head) : null
  }
  pin(room: StoredRoom, reader: string, id: string, rev: string): void {
    if (!room.archived) this.git(['update-ref', `refs/ringi/accepted/${room.genesis}/${reader}/${id}`, rev])
  }
  unpin(room: StoredRoom, reader: string, id: string): void {
    this.gitOk(['update-ref', '-d', `refs/ringi/accepted/${room.genesis}/${reader}/${id}`])
  }
  file(rev: string, p: string): Buffer { return runGitRaw(this.args(['show', `${rev}:${p}`]), this.home) }
  sizes(rev: string, paths: string[]): Map<string, number> {
    if (!paths.length) return new Map()
    const wanted = new Set(paths)
    return new Map(splitBuf(runGitRaw(this.args(['ls-tree', '-r', '-l', '-z', rev]), this.home), 0)
      .map(b => /^\d+ blob [0-9a-f]+ +(\d+)\t(.*)$/s.exec(b.toString('utf8'))).filter((x): x is RegExpExecArray => !!x)
      .filter(([, , p]) => wanted.has(p)).map(([, n, p]) => [p, Number(n)] as [string, number]))
  }

  // --- signals ---

  // An annotated tag in its author's namespace under the room's genesis (a room recreated under the same name is
  // another namespace), signed on a signed hub. Writing the same signal twice is a no-op.
  signal(room: StoredRoom, who: string, target: string, name: string, text: string): void {
    const tag = `ringi/${room.genesis}/${who}/${name}`
    const ref = `refs/tags/${tag}`
    if (this.gitOk(['rev-parse', '-q', '--verify', ref]).status === 0) {
      Remote.push(this.h, ref)
      return
    }
    const sign = Remote.sign(this.h, who, this.home)
    const key = sign[0]?.slice(2)
    this.git([...(key ? ['-c', `user.signingkey=${key}`] : []), 'tag', key ? '-s' : '-a', '-F', '-', tag, target], {input: text, env: ident(who)})
    Remote.push(this.h, ref)
  }
  signals(room: StoredRoom): SignalRecord[] {
    const prefix = room.archived ? `refs/archive/${room.name}/signals/` : `refs/tags/ringi/${room.genesis}/`
    const raw = this.git(['for-each-ref', '--format=%(refname)%1f%(objectname)%1f%(objecttype)%1f%(*objectname)%1f%(taggername)%1f%(contents)%1e', prefix])
    const records = raw.split('\x1e').map(s => s.replace(/^\n/, '')).filter(Boolean).map(rec => {
      const [ref, object, type, target, tagger, text = ''] = rec.split('\x1f')
      const [actor, ...rest] = ref.slice(prefix.length).split('/')
      // Only an annotated tag on a commit is a signal; anything else points nowhere.
      return {ref, object, name: rest.join('/'), actor, target: type === 'tag' ? target : '', tagger, text}
    })
    if (this.trust !== 'signed' || room.archived) return records
    return Remote.withVerification(this.h, () => records.filter(s => {
      const why = Remote.verifySignal(this.h, this.legacy(room), s.ref, s.object)
      if (why) note(`ALARM signal ${s.ref}: ${why}; quarantined and withheld`)
      return !why
    }))
  }

  // --- signed stores ---

  admit(room: StoredRoom, who: string, key: string): string { return Remote.roomAdmit(this.h, this.legacy(room), who, key, this.home) }
  joinKey(room: StoredRoom, who: string): JoinKey { return Remote.join(this.h, this.legacy(room), who, this.home) }
  forgetLog(room: StoredRoom, id: string): void { Remote.forget(this.h, this.legacy(room), id) }
  rootKey(): string { return this.d.root ?? fail(`hub ${this.d.name} has no pinned root`) }
  rootRoster(): string { return Remote.rootRoster(this.h) }
}
