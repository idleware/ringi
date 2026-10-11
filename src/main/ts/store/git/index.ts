// git-store: the Store port on git. The store directory holds one bare repository (`store/.git`):
//   refs/heads/main                       the shared contract, one commit per amendment
//   refs/heads/<room>                     the room: one linear branch, like a chat. Its first commit is the room's genesis
//                                         (the root's, on top of main); then every message is a commit by its author, and
//                                         every control record (Kind: room) a commit by the root
//   refs/tags/ringi/<genesis>/<agent>/<message>.<signal>   signals, annotated tags in their author's namespace
//   refs/archive/<room>@<genesis8>        an archived room, read-only
//   refs/ringi/accepted/<genesis>/<reader>/<author>   readers' pins of each author's accepted last message
// A member's log is its own commits in the room's branch, in branch order. The control files at the root of a room's
// tree (members, profile, signers) change only in the root's control records.
// A signed hub signs every commit and tag with its author's key and verifies what it fetches (remote.ts).

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {spawnSync} from 'node:child_process'
import type {SpawnSyncReturns} from 'node:child_process'
import {cannotWrite, mkdirIn, SANDBOX} from '../../lib/index.ts'
import * as Remote from './remote.ts'
import type {Descriptor, JoinKey, Roster, SignalRecord, Store, StoredMessage, StoredRoom} from '../index.ts'
import {fail, note, strictJson} from '../../lib/index.ts'
import {ID_RE, TEXT_MAX, checkOutgoing, compose, parse} from '../../protocol/index.ts'
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
// The root's principal, and the files only its control records may change.
const ROOT = 'operator'
const CONTROL_FILES = new Set(['ROOM.md', 'members.json', 'profile.json', 'allowed_signers'])
// One commit of a room's branch: who wrote it, and whether it is a control record.
type Entry_ = {sha: string, author: string, text: string, control: boolean, skipped?: string}
type Named = Pick<StoredRoom, 'name' | 'genesis' | 'archived'>

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

  // A tree from a base tree without the `drop` paths, with entries put on top; nested paths are fine.
  private tree(base: string | null, entries: Entry[], drop: string[] = []): string {
    const idx = path.join(this.home, 'tmp', `index.${process.pid}.${crypto.randomBytes(4).toString('hex')}`)
    mkdirIn(this.home, path.dirname(idx))
    const env = {GIT_INDEX_FILE: idx}
    try {
      this.git(['read-tree', ...(base ? [base] : ['--empty'])], {env})
      if (drop.length) this.git(['update-index', '--index-info'], {env, input: drop.map(p => `0 ${ZERO}\t${p}\n`).join('')})
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
    return Remote.push(this.h, ref, {behind: !!old && ref !== 'refs/heads/main'})
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

  private ref(name: string) { return name.includes('@') ? `refs/archive/${name}` : `refs/heads/${name}` }
  private transition(name: string) { return `refs/ringi/migrating/${name}` }
  private tip(name: string) { return this.rev(this.ref(name)) ?? this.rev(this.transition(name)) }
  // Rooms in ringi 0.1's layout (`<room>/control` and a branch per agent) are listed, and refused when opened.
  roomNames(archived: boolean): string[] {
    const prefix = archived ? 'refs/archive/' : 'refs/heads/'
    const names = this.git(['for-each-ref', '--format=%(refname)', prefix]).split('\n').filter(Boolean).map(r => r.slice(prefix.length))
      .map(n => n.replace(/\/control$/, '')).filter(n => !n.includes('/') && n !== 'main' && n.includes('@') === archived)
    return [...new Set(names)].sort()
  }
  // A control record: the room's genesis, or a root commit of Kind: room.
  private isControl(room: Pick<StoredRoom, 'genesis'>, sha: string, author: string, text: string): boolean {
    return sha === room.genesis || (author === ROOT && parse(text, x => this.isRef(x)).kind === 'room')
  }
  // The room's branch, oldest first, from its genesis. The last scan of each room is kept and grown by what the tip
  // added on top of it.
  private scanned = new Map<string, {tip: string, entries: Entry_[]}>()
  private entries(room: Named, tip: string): Entry_[] {
    const last = this.scanned.get(room.genesis)
    if (last?.tip === tip) return last.entries
    const added = last ? this.scan(room, tip, last.tip) : []
    const entries = last && added.length && added[0].parent === last.tip ? [...last.entries, ...added] : this.scan(room, tip)
    const judged = this.judged(room, tip, entries)
    this.scanned.set(room.genesis, {tip, entries: judged})
    return judged
  }
  // On a signed hub the branch's verification says which commits are control records, and why the others that are no
  // valid message are skipped; a commit off the branch's first parents is never a message (remote.ts).
  private judged(room: Named, tip: string, entries: Entry_[]): Entry_[] {
    if (this.trust !== 'signed' || room.archived) return entries
    const b = Remote.branch(this.h, {name: room.name, ref: this.ref(room.name), genesis: room.genesis}, tip)
    const control = new Set(b.control)
    return entries.map(e => ({...e, control: control.has(e.sha),
      skipped: control.has(e.sha) || b.authors.has(e.sha) ? undefined : b.skipped.get(e.sha) ?? 'not on the room\'s branch'}))
  }
  private scan(room: Pick<StoredRoom, 'genesis'>, tip: string, after?: string): Array<Entry_ & {parent: string}> {
    const shas = this.git(['rev-list', '--topo-order', '--reverse', tip, '--not', after ?? `${room.genesis}^@`]).trim().split('\n').filter(Boolean)
    return Remote.readCommits(this.h, shas).map(c => {
      const text = c.body.toString('utf8')
      return {sha: c.sha, parent: c.parents[0], author: c.author, text, control: this.isControl(room, c.sha, c.author, text)}
    })
  }
  room(name: string): StoredRoom | null {
    const ref = this.ref(name)
    const tip = this.tip(name)
    if (!tip && this.rev(`${ref}/control`)) fail(`room ${name} is in the layout of ringi 0.1; run ringi room migrate ${name} --hub ${this.d.name} to keep its history in one branch`)
    if (!tip) return null
    const genesis = this.git(['rev-list', '--first-parent', '--reverse', tip, '^refs/heads/main']).split('\n')[0]
      || this.git(['rev-list', '--first-parent', '--reverse', tip]).split('\n').filter(Boolean).at(-1)!
    const archived = name.includes('@')
    if (this.trust === 'signed' && !archived && this.h.remoteAlarms?.[ref]) fail(`ALARM ${this.h.remoteAlarms[ref]}; room ${name} is quarantined`)
    const control = this.entries({name, genesis, archived}, tip).filter(e => e.control).map(e => ({rev: e.sha, text: e.text}))
    return {name, archived, head: control.at(-1)!.rev, genesis, tip, base: this.rev(`${genesis}^`) ?? ZERO, control}
  }
  // Control files are read at a control record, never at the branch's tip.
  controlFile(room: StoredRoom, name: string, rev?: string): string | null {
    const r = this.gitOk(['show', `${rev ?? room.head}:${name}`])
    return r.status === 0 ? r.stdout : null
  }
  createRoom(name: string, who: string, text: string, files: Record<string, string>): string {
    const ref = `refs/heads/${name}`
    if (this.rev(ref)) fail(`room ${name} exists in hub ${this.d.name}`)
    const sha = this.commit(who, text, this.tree(null, Object.entries(files).map(([p, c]) => ({path: p, content: c, mode: '100644'}))), [this.contractHead()])
    if (!this.advance(ref, sha, null)) fail(`room ${name} was created meanwhile`)
    return sha
  }
  // Old messages keep their ids and parents. One control record joins the old tips, then all new writes share the
  // room's branch. The transition ref makes the room readable even if the process exits between the two ref
  // transactions (Git cannot create <room> and delete <room>/control in the same transaction).
  migrateRoom(name: string): string {
    if (this.trust !== 'asserted') fail('legacy room migration is only supported for local asserted hubs')
    if (!ID_RE.test(name) || name === 'main') fail('expected a room id')
    const ref = this.ref(name), pending = this.transition(name)
    const finish = (sha: string) => {
      this.git(['update-ref', '--stdin'], {input: `start\ncreate ${ref} ${sha}\ndelete ${pending} ${sha}\nprepare\ncommit\n`})
      return sha
    }
    const staged = this.rev(pending)
    if (staged) return finish(staged)
    const current = this.rev(ref)
    if (current) return current
    const ctl = `${ref}/control`, head = this.rev(ctl) ?? fail(`no legacy room ${name}`)
    const genesis = this.git(['rev-list', '--reverse', head, '^refs/heads/main']).trim().split('\n')[0]
    if (!genesis || this.git(['show', '-s', '--format=%s', genesis]).trim() !== `room ${name}`) fail('legacy room genesis does not name this room')
    const logs = this.refsUnder(`${ref}/log/`)
    for (const [r, sha] of [[ctl, head], ...logs]) {
      const who = r === ctl ? ROOT : r.slice(`${ref}/log/`.length)
      if (!ID_RE.test(who) || !this.extends(genesis, sha)) fail(`ALARM ${r} does not descend from its room genesis`)
      const commits = this.git(['rev-list', '--parents', '--reverse', sha, `^${genesis}`]).trim().split('\n').filter(Boolean)
      let parent = genesis
      for (const row of commits) {
        const [id, ...parents] = row.split(' ')
        if (parents.length !== 1 || parents[0] !== parent) fail(`ALARM ${r} is not linear`)
        if (this.git(['show', '-s', '--format=%an', id]).trim() !== who) fail(`ALARM ${r} contains another author's message`)
        parent = id
      }
    }
    // Accepted heads must still be present before any ref moves. Migration never supplies a fresh baseline.
    const byAuthor = new Map(logs.map(([r, sha]) => [r.slice(`${ref}/log/`.length), sha]))
    const checkAccepted = (who: string, sha: string) => {
      const tip = byAuthor.get(who)
      if (!tip || !this.extends(sha, tip)) fail(`ALARM log ${who} lost accepted history; migration stopped`)
    }
    for (const [r, sha] of this.refsUnder(`refs/ringi/accepted/${genesis}/`)) checkAccepted(r.split('/').at(-1)!, sha)
    const readers = path.join(this.home, 'readers', this.d.name, genesis)
    for (const f of fs.existsSync(readers) ? fs.readdirSync(readers).filter(f => f.endsWith('.json')) : []) {
      const st = strictJson<{control?: string, heads?: Record<string, string>}>(fs.readFileSync(path.join(readers, f), 'utf8'), f)
      if (st.control && !this.extends(st.control, head)) fail('ALARM room control lost accepted history; migration stopped')
      for (const [who, sha] of Object.entries(st.heads ?? {})) checkAccepted(who, sha)
    }
    const sha = this.commit(ROOT, compose(`migrate room ${name}`, [['To', '*'], ['Kind', 'room'], ['Ringi-Layout', 'branch/1']]),
      this.git(['rev-parse', `${head}^{tree}`]).trim(), [...new Set([head, ...logs.map(([, id]) => id)])])
    const old = [[ctl, head], ...logs]
    const backup = `refs/ringi/legacy/${genesis}/`
    this.git(['update-ref', '--stdin'], {input: ['start', `create ${pending} ${sha}`,
      ...old.flatMap(([r, id]) => [`create ${backup}${r.slice(`${ref}/`.length)} ${id}`, `delete ${r} ${id}`]),
      'prepare', 'commit', ''].join('\n')})
    return finish(sha)
  }
  // A control record on top of the branch: the control files come from the last control record, never from the tip,
  // and the messages' files are kept.
  updateControl(room: StoredRoom, who: string, text: string, files: Record<string, string>): string {
    const kept = [...CONTROL_FILES].flatMap(n => { const c = this.controlFile(room, n); return c === null ? [] : [[n, c] as const] })
    const all = {...Object.fromEntries(kept), ...files}
    return this.onTop(room, who, text, Object.entries(all).map(([p, c]) => ({path: p, content: c, mode: '100644'})), [...CONTROL_FILES])
  }
  private refsUnder(prefix: string): Array<[string, string]> {
    return this.git(['for-each-ref', '--format=%(refname) %(objectname)', prefix]).split('\n').filter(Boolean).map(l => l.split(' ') as [string, string])
  }
  // The branch moves under the archive; signals stay under the room's genesis.
  archiveRoom(room: StoredRoom, as: string): void {
    const tip = this.rev(this.ref(room.name)) ?? fail(`room ${room.name} is gone`)
    this.git(['update-ref', `refs/archive/${as}`, tip, ZERO])
    this.git(['update-ref', '-d', this.ref(room.name), tip])
  }
  deleteRoom(room: StoredRoom): void {
    this.gitOk(['update-ref', '-d', this.ref(room.name)])
    for (const prefix of [`refs/ringi/accepted/${room.genesis}/`, `refs/tags/ringi/${room.genesis}/`]) {
      for (const [ref] of this.refsUnder(prefix)) this.git(['update-ref', '-d', ref])
    }
  }
  private remote(room: StoredRoom): Remote.Room {
    return {name: room.name, ref: this.ref(room.name), head: room.head, genesis: room.genesis, archived: room.archived}
  }
  roster(room: StoredRoom): Roster | null {
    if (this.trust !== 'signed' || room.archived) return null
    const v = Remote.verifyRoom(this.h, this.remote(room))
    return {members: v.members, signers: v.entries}
  }

  // --- logs ---

  // Logs are read at the branch's live tip, as a reader sees the room now.
  private live(room: StoredRoom): Entry_[] {
    const tip = this.tip(room.name)
    return tip ? this.entries(room, tip).filter(e => !e.control && !e.skipped) : []
  }
  // What a signed hub skips in the room's branch, as alarms; the room reads on without it.
  alarms(room: StoredRoom): string[] {
    const tip = this.tip(room.name)
    return tip ? this.entries(room, tip).filter(e => e.skipped).map(e => `commit ${e.sha.slice(0, 12)} by ${e.author || '(none)'}: ${e.skipped}`) : []
  }
  logIds(room: StoredRoom): string[] { return [...new Set(this.live(room).map(e => e.author))] }
  logHead(room: StoredRoom, id: string): string | null { return this.live(room).filter(e => e.author === id).at(-1)?.sha ?? null }
  // One author's messages after the genesis up to `head`, oldest first, read as bytes: the text is the commit message,
  // the files are the explicit Ringi-Files list, or the paths the commit adds or changes for records without it.
  messages(room: StoredRoom, id: string, head: string): StoredMessage[] {
    const tip = this.trust === 'signed' ? this.tip(room.name) : null
    const skipped = new Set(tip ? this.entries(room, tip).filter(e => e.skipped).map(e => e.sha) : [])
    const raw = runGitRaw(this.args(['log', '--topo-order', '--reverse', '--no-renames', '--raw', '--no-abbrev', '--format=%x1e%H%x1f%P%x1f%ct%x1f', head, `^${room.genesis}`]), this.home)
    const records = splitBuf(raw, 0x1e).filter(b => b.length).map(rec => splitBuf(rec, 0x1f))
    const commits = new Map(Remote.readCommits(this.h, records.map(([sha]) => sha.toString())).map(c => [c.sha, c]))
    return records.flatMap(([sha, parent, ct, rest = Buffer.alloc(0)]) => {
      const {author, body} = commits.get(sha.toString())!
      if (author !== id || this.isControl(room, sha.toString(), id, body.toString('utf8')) || skipped.has(sha.toString())) return []
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
      return [{id: sha.toString(), parent: parent.toString() || null, time: Number(ct.toString()), text: body,
        files: files.filter(f => REGULAR.has(f.mode)), refused: [...refused, ...files.filter(f => !REGULAR.has(f.mode))]}]
    })
  }
  // One message on top of the room's branch.
  append(room: StoredRoom, who: string, text: string, entries: Entry[]): string {
    if (room.archived) fail(`room ${room.name} is archived: read-only`)
    if (checkOutgoing(text, s => this.isRef(s)).trailers['ringi-files']) fail('Ringi-Files is store metadata; supply attachments instead')
    const own = entries.find(e => CONTROL_FILES.has(e.path))
    if (own) fail(`${own.path} is the room's own file; attach it under another path`)
    if (entries.length) text = `${text.trimEnd()}\nRingi-Files: ${JSON.stringify([...new Set(entries.map(e => e.path))])}\n`
    if (Buffer.byteLength(text) > TEXT_MAX) fail('attachment list makes the message exceed 64 KiB; use fewer or shorter paths')
    checkOutgoing(text, s => this.isRef(s))
    return this.onTop(room, who, text, entries)
  }
  // A commit on the branch's tip, compare-and-swap: when another writer got there first, it is made again on the new tip.
  private onTop(room: StoredRoom, who: string, text: string, entries: Entry[], drop: string[] = []): string {
    const ref = this.ref(room.name)
    for (let i = 0; i < 8; i++) {
      const tip = this.rev(ref) ?? fail(`room ${room.name} is gone`)
      if (drop.length && this.room(room.name)?.head !== room.head) fail('room control moved while writing; retry the operation')
      const tree = entries.length || drop.length ? this.tree(`${tip}^{tree}`, entries, drop) : this.git(['rev-parse', `${tip}^{tree}`]).trim()
      const sha = this.commit(who, text, tree, [tip])
      if (this.advance(ref, sha, tip)) return sha
    }
    return fail(`room ${room.name} kept moving while writing; retry`)
  }
  verifyLog(room: StoredRoom, id: string, head: string): string | null {
    return this.trust === 'signed' ? Remote.verify(this.h, this.remote(room), id, head) : null
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
    const prefix = `refs/tags/ringi/${room.genesis}/`
    const raw = this.git(['for-each-ref', '--format=%(refname)%1f%(objectname)%1f%(objecttype)%1f%(*objectname)%1f%(taggername)%1f%(contents)%1e', prefix])
    const records = raw.split('\x1e').map(s => s.replace(/^\n/, '')).filter(Boolean).map(rec => {
      const [ref, object, type, target, tagger, text = ''] = rec.split('\x1f')
      const [actor, ...rest] = ref.slice(prefix.length).split('/')
      // Only an annotated tag on a commit is a signal; anything else points nowhere.
      return {ref, object, name: rest.join('/'), actor, target: type === 'tag' ? target : '', tagger, text}
    })
    if (this.trust !== 'signed' || room.archived) return records
    return Remote.withVerification(this.h, () => records.filter(s => {
      const why = Remote.verifySignal(this.h, this.remote(room), s.ref, s.object)
      if (why) note(`ALARM signal ${s.ref}: ${why}; quarantined and withheld`)
      return !why
    }))
  }

  // --- signed stores ---

  admit(room: StoredRoom, who: string, key: string): string { return Remote.roomAdmit(this.h, this.remote(room), who, key, this.home) }
  joinKey(room: StoredRoom, who: string): JoinKey { return Remote.join(this.h, this.remote(room), who, this.home) }
  // A room's transport alarm is the room's, whichever author the operator forgets.
  forgetLog(room: StoredRoom, _id: string): void { Remote.forget(this.h, this.remote(room)) }
  rootKey(): string { return this.d.root ?? fail(`hub ${this.d.name} has no pinned root`) }
  rootRoster(): string { return Remote.rootRoster(this.h) }
}
