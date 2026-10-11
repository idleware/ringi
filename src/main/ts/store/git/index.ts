// git-store: the Store port on git. The store directory holds one bare repository (`store/.git`):
//   refs/heads/main                       the shared contract, one commit per amendment
//   refs/heads/<room>                     the room: one linear branch, like a chat. Its first commit is the room's genesis
//                                         (the root's, on top of main); then every message is a commit by its author, and
//                                         every control record (Kind: room) a commit by the root
//   refs/tags/<agent>.<signal>.<message12>   signals: annotated tags without text on the message's commit
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
import {fail, locked, note, strictJson, writeJsonAtomic} from '../../lib/index.ts'
import {AGENT_RE, ID_RE, TEXT_MAX, checkOutgoing, compose, parse} from '../../protocol/index.ts'
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
const runGitRaw = (args: string[], where?: string, input?: Buffer): Buffer => {
  const r = spawnSync('git', args, {input, encoding: 'buffer', env: Remote.gitEnv(), maxBuffer: 1 << 30, timeout: Remote.gitTimeout()})
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
// The store is a repository whose work tree holds the contract (`main`) as it is now, so Git clients (SourceTree, IDEs)
// open `store/` without errors, on the contract, with every room's branch beside it; `git status` stays clean.
const init = (dir: string, home: string) => runGit(['init', '-q', '-b', 'main', path.dirname(dir)], {where: home})
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
    this.openable()
  }
  // A store made bare before, or a replica fetched bare, gets its work tree once (and loses the `_ringi` branch of an unreleased build).
  private openable(): void {
    let changed = false
    if (/^\s*bare\s*=\s*true\s*$/m.test(fs.readFileSync(path.join(this.dir, 'config'), 'utf8'))) { this.git(['config', 'core.bare', 'false']); changed = true }
    if (fs.readFileSync(path.join(this.dir, 'HEAD'), 'utf8') !== 'ref: refs/heads/main\n') { this.git(['symbolic-ref', 'HEAD', 'refs/heads/main']); changed = true }
    if (fs.existsSync(path.join(this.dir, 'refs', 'heads', '_ringi'))) { this.gitOk(['update-ref', '-d', 'refs/heads/_ringi']); changed = true }
    if (changed) this.checkout()
  }
  // The work tree and the index follow the contract, so a Git client sees the store clean.
  private checkout(): void {
    if (this.rev('refs/heads/main')) this.git(['--work-tree', path.dirname(this.dir), 'read-tree', '-u', '--reset', 'refs/heads/main'])
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
        const sha = e.blob ?? this.git(['hash-object', '-w', ...(e.file ? ['--', e.file] : ['--stdin'])], {input: e.content}).trim()
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
      init(dir, home)
    }
    const s = new GitStore(hubDir, d, home)
    const sha = s.commit('operator', text, s.tree(null, Object.entries(contract).map(([p, c]) => ({path: p, content: c, mode: '100644'}))), [])
    if (d.trust === 'signed') d.genesis = sha
    if (!s.advance('refs/heads/main', sha, null)) fail(`hub ${d.name}: main already exists`)
    s.checkout()
    return s
  }
  // A new signed hub: the root key is generated on this machine and pinned in the descriptor.
  static rootFor(hubDir: string, d: Descriptor, home: string): string {
    const dir = path.join(hubDir, d.store.path, '.git')
    mkdirIn(home, path.dirname(dir))
    init(dir, home)
    return Remote.setupSigned({name: d.name, dir, d}, home, d.store.remote).root
  }

  sync(): void {
    const main = this.rev('refs/heads/main')
    Remote.sync(this.h)
    if (this.rev('refs/heads/main') !== main) this.checkout()
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
    this.checkout()
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
      .map(n => n.replace(/\/control$/, '')).filter(n => ID_RE.test(n.split('@')[0]) && n !== 'main' && n.includes('@') === archived)
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
    const source = this.rev(pending) ?? this.rev(ref) ?? this.rev(`${ref}/control`) ?? fail(`no legacy room ${name}`)
    const genesis = this.git(['rev-list', '--first-parent', '--reverse', source, '^refs/heads/main']).trim().split('\n')[0]
    const readers = path.join(this.home, 'readers', this.d.name, genesis)
    const files = fs.existsSync(readers) ? fs.readdirSync(readers).filter(f => f.endsWith('.json')).sort() : []
    // Readers pin tag objects while holding these same locks. Keep their state stable across both ref transactions
    // and the explicit conversion of their old accepted objects; no new baseline is supplied.
    const protect = (at: number): string => at === files.length ? migrate() : locked(path.join(this.home, 'locks',
      `reader-${this.d.name}-${genesis.slice(0, 12)}-${files[at].slice(0, -5)}.lock`), () => protect(at + 1))
    const migrate = (): string => {
      if (!genesis || this.git(['show', '-s', '--format=%s', genesis]).trim() !== `room ${name}`) fail('legacy room genesis does not name this room')
      const finish = (sha: string) => {
        this.git(['update-ref', '--stdin'], {input: `start\ncreate ${ref} ${sha}\ndelete ${pending} ${sha}\nprepare\ncommit\n`})
        return sha
      }
      const staged = this.rev(pending)
      const current = this.rev(ref)
      if (staged || current) {
        const tip = staged ?? current!
        const tags = this.migrateSignals(name, genesis, [tip], files.map(f => path.join(readers, f)))
        if (staged) finish(staged)
        tags()
        return tip
      }
      const ctl = `${ref}/control`, head = this.rev(ctl) ?? fail(`no legacy room ${name}`)
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
      for (const f of files) {
        const st = strictJson<{control?: string, heads?: Record<string, string>}>(fs.readFileSync(path.join(readers, f), 'utf8'), f)
        if (st.control && !this.extends(st.control, head)) fail('ALARM room control lost accepted history; migration stopped')
        for (const [who, sha] of Object.entries(st.heads ?? {})) checkAccepted(who, sha)
      }
      const tags = this.migrateSignals(name, genesis, [head, ...logs.map(([, id]) => id)], files.map(f => path.join(readers, f)))
      const sha = this.commit(ROOT, compose(`migrate room ${name}`, [['To', '*'], ['Kind', 'room'], ['Ringi-Layout', 'branch/1']]),
        this.git(['rev-parse', `${head}^{tree}`]).trim(), [...new Set([head, ...logs.map(([, id]) => id)])])
      const old = [[ctl, head], ...logs]
      const backup = `refs/ringi/legacy/${genesis}/`
      this.git(['update-ref', '--stdin'], {input: ['start', `create ${pending} ${sha}`,
        ...old.flatMap(([r, id]) => [`create ${backup}${r.slice(`${ref}/`.length)} ${id}`, `delete ${r} ${id}`]),
        'prepare', 'commit', ''].join('\n')})
      finish(sha)
      tags()
      return sha
    }
    mkdirIn(this.home, path.join(this.home, 'locks'))
    return protect(0)
  }
  // An asserted hub can explicitly convert its old tag annotations, keeping their target, tagger and date. The
  // original objects and reader snapshots remain evidence. Ref changes are atomic; a repeat resumes reader writes
  // after a crash without replacing an accepted object that changed or disappeared in either format.
  private migrateSignals(room: string, genesis: string, tips: string[], readers: string[]): () => void {
    const prefix = `refs/tags/ringi/${genesis}/`, backup = `refs/ringi/legacy/${genesis}/signals/`
    const old = new Map(this.refsUnder(prefix)), saved = new Map(this.refsUnder(backup))
    const liveTags = new Map(this.refsUnder('refs/tags/'))
    const refs: string[] = []
    const changes = new Map<string, {before: string, after: string}>()
    const identities = new Map<string, {key: string, target: string, signal: string}>()
    const targets = new Set(this.git(['rev-list', ...tips, `^${genesis}`]).trim().split('\n').filter(Boolean))
    const kept = (sha: string): boolean => tips.some(tip => this.extends(sha, tip))
    for (const [ref, sha] of this.refsUnder(`refs/ringi/accepted/${genesis}/`)) {
      if (!kept(sha)) fail(`ALARM ${ref} lost accepted history; migration stopped`)
    }
    for (const suffix of new Set([...old.keys()].map(r => r.slice(prefix.length)).concat([...saved.keys()].map(r => r.slice(backup.length))))) {
      const before = saved.get(backup + suffix) ?? old.get(prefix + suffix)!
      const liveOld = old.get(prefix + suffix), recorded = saved.get(backup + suffix)
      if (recorded && liveOld && recorded !== liveOld) fail(`ALARM signal ${prefix + suffix} changed after migration; stopped`)
      const m = /^([^/]+)\/((?:[0-9a-f]{40}|[0-9a-f]{64}))\.([a-z][a-z0-9.-]*)$/.exec(suffix)
      if (!m || !AGENT_RE.test(m[1])) return fail(`ALARM signal ${prefix + suffix} cannot be migrated to an unambiguous agent id`)
      const [, actor, target, signal] = m
      if (this.git(['cat-file', '-t', before]).trim() !== 'tag') fail(`ALARM signal ${prefix + suffix} is not annotated`)
      const text = this.git(['cat-file', 'tag', before])
      const split = text.indexOf('\n\n'), header = text.slice(0, split), body = text.slice(split + 2)
      const h = /^object ([0-9a-f]+)\ntype commit\ntag ([^\n]+)\n(tagger ([^<\n]+) <[^\n]*> \d+ [+-]\d{4})$/.exec(header)
      if (!h || h[1] !== target || h[2] !== (prefix + suffix).slice('refs/tags/'.length) || h[4].trim() !== actor || !targets.has(target))
        return fail(`ALARM signal ${prefix + suffix} disagrees with its name, actor or room target`)
      if (body.includes('-----BEGIN')) fail('signed legacy signals need their authors to sign the new names; migration stopped')
      const p = parse(body, s => this.isRef(s))
      for (const [k, value] of [['room', room], ['genesis', genesis], ['actor', actor], ['message', target], ['signal', signal]]) {
        if (p.trailers[k]?.length !== 1 || p.trailers[k][0] !== value) fail(`ALARM signal ${prefix + suffix} has inconsistent legacy metadata`)
      }
      const key = `${actor}.${signal}.${target.slice(0, 12)}`, ref = `refs/tags/${key}`
      const after = this.git(['mktag'], {input: `object ${target}\ntype commit\ntag ${key}\n${h[3]}\n\n`}).trim()
      const existing = changes.get(key), live = liveTags.get(ref)
      if ((existing && existing.after !== after) || (live && live !== after)) fail(`ALARM signal ${key} collides with another tag; migration stopped`)
      if (recorded && !live) fail(`ALARM migrated signal ${key} was removed; migration stopped`)
      changes.set(key, {before, after})
      identities.set(before, {key, target, signal})
      identities.set(after, {key, target, signal})
      if (!recorded) refs.push(`create ${backup + suffix} ${before}`)
      if (!live) refs.push(`create ${ref} ${after}`)
      if (liveOld) refs.push(`delete ${prefix + suffix} ${liveOld}`)
    }
    const planned = readers.map(file => {
      const text = fs.readFileSync(file, 'utf8')
      const st = strictJson<Record<string, unknown> & {signals?: Record<string, string>}>(text, file)
      if (typeof st.control === 'string' && !kept(st.control)) fail('ALARM room control lost accepted history; migration stopped')
      for (const sha of Object.values(st.heads as Record<string, string> ?? {})) {
        if (!kept(sha)) fail('ALARM room log lost accepted history; migration stopped')
      }
      const next: Record<string, string> = {}
      for (const [original, object] of Object.entries(st.signals ?? {})) {
        const m = /(?:^|\/)([^/]+)\/((?:[0-9a-f]{40}|[0-9a-f]{64}))\.([a-z][a-z0-9.-]*)$/.exec(original)
        // An early reader shortened a full ref to its last component and lost the actor. Its pinned object still
        // proves the identity: recover it only from an exact, verified old object retained by this migration.
        const bare = /^((?:[0-9a-f]{40}|[0-9a-f]{64}))\.([a-z][a-z0-9.-]*)$/.exec(original)
        const identity = bare ? identities.get(object) : undefined
        if (bare && (!identity || identity.target !== bare[1] || identity.signal !== bare[2])) fail(`ALARM accepted signal ${original} lost its verified identity; migration stopped`)
        const key = m ? `${m[1]}.${m[3]}.${m[2].slice(0, 12)}` : identity?.key ?? original
        const change = changes.get(key)
        if (m && !change) fail(`ALARM accepted signal ${original} is missing; migration stopped`)
        if (!change && /^[a-z0-9]+(?:[_-][a-z0-9]+)*\.[a-z][a-z0-9.-]*\.[0-9a-f]{12}$/.test(key)
          && liveTags.get(`refs/tags/${key}`) !== object) fail(`ALARM accepted signal ${original} is missing or replaced; migration stopped`)
        if (change && object !== change.before && object !== change.after) fail(`ALARM accepted signal ${original} was replaced; migration stopped`)
        const value = change?.after ?? object
        if (next[key] && next[key] !== value) fail(`ALARM accepted signal ${key} has conflicting objects; migration stopped`)
        next[key] = value
      }
      return {file, text, st, next, changed: JSON.stringify(st.signals ?? {}) !== JSON.stringify(next)}
    })
    return () => {
      if (refs.length) this.git(['update-ref', '--stdin'], {input: ['start', ...refs, 'prepare', 'commit', ''].join('\n')})
      for (const p of planned) {
        if (!p.changed) continue
        // Separate from the live readers directory so the snapshot is never mistaken for another reader.
        const dir = path.join(this.home, 'migration', this.d.name, genesis, 'readers')
        mkdirIn(this.home, dir)
        const snapshot = path.join(dir, `${path.basename(p.file)}.${crypto.createHash('sha256').update(p.text).digest('hex')}`)
        if (!fs.existsSync(snapshot)) fs.writeFileSync(snapshot, p.text, {flag: 'wx', mode: 0o600})
        else if (fs.readFileSync(snapshot, 'utf8') !== p.text) fail('ALARM migration reader snapshot changed; migration stopped')
        writeJsonAtomic(p.file, {...p.st, signals: p.next})
      }
    }
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
  // The branch moves under the archive; its signals stay where they are, on its commits.
  archiveRoom(room: StoredRoom, as: string): void {
    const tip = this.rev(this.ref(room.name)) ?? fail(`room ${room.name} is gone`)
    this.git(['update-ref', `refs/archive/${as}`, tip, ZERO])
    this.git(['update-ref', '-d', this.ref(room.name), tip])
  }
  // Every ref of the room in one transaction: its branch (or archive) and a pending migration, every tag on its
  // commits (signals, ringi 0.1's, anyone's), what the store keeps under its genesis (pins, ringi 0.1's refs, evidence)
  // and its unpublished commits; then the migration's backup of its readers. Objects are left to the repository.
  deleteRoom(room: StoredRoom): void {
    const commits = this.commitsOf(room)
    const tags = this.git(['for-each-ref', '--format=%(refname) %(objectname) %(*objectname)', 'refs/tags/']).split('\n').filter(Boolean)
      .map(l => l.split(' ')).filter(([ref, object, target]) => commits.has(target || object) || ref.startsWith(`refs/tags/ringi/${room.genesis}/`)).map(([ref]) => ref)
    const kept = this.refsUnder('refs/ringi/').map(([ref]) => ref).filter(ref => {
      const [, , kind, key] = ref.split('/')
      return key === room.genesis || (kind === 'unpublished' && commits.has(key))
    })
    const refs = [this.ref(room.name), this.transition(room.name)].filter(r => this.rev(r)).concat(tags, kept)
    this.git(['update-ref', '--stdin'], {input: ['start', ...refs.map(r => `delete ${r}`), 'prepare', 'commit', ''].join('\n')})
    fs.rmSync(path.join(this.home, 'migration', this.d.name, room.genesis), {recursive: true, force: true})
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
  blob(file: string): {id: string, size: number} {
    const id = this.git(['hash-object', '-w', '--', file]).trim()
    return {id, size: Number(this.git(['cat-file', '-s', id]).trim())}
  }
  // A tree of the staged files under refs/ringi/staged/<genesis>/<who>: git keeps what a ref reaches.
  retain(room: StoredRoom, who: string, entries: Entry[]): void {
    const ref = `refs/ringi/staged/${room.genesis}/${who}`
    if (!entries.length) { this.gitOk(['update-ref', '-d', ref]); return }
    this.git(['update-ref', ref, this.tree(null, entries)])
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

  // The heartbeat of `who` in the room: a tag `<who>.heartbeat.<genesis12>` on the room's last commit here, its text the
  // facts of the beat (heartbeat/). Each beat replaces the object under the same name, compare-and-swap on the one it
  // read, so two writers do not overwrite each other blindly. No reader pins it; its replacement is no alarm.
  // On a signed hub the object is signed by `who` and published with the OID it replaced; a newer beat there wins, and
  // this one is taken back here (remote.ts).
  heartbeat(room: StoredRoom, who: string, target: string, text: string): string {
    const ref = Remote.heartbeatRef(who, room.genesis), name = ref.slice('refs/tags/'.length)
    const old = this.rev(`${ref}^{tag}`) ? this.git(['rev-parse', ref]).trim() : null
    const obj = this.trust === 'signed' ? Remote.makeHeartbeat(this.h, this.remote(room), who, target, text, this.home)
      : this.git(['mktag'], {input: `object ${target}\ntype commit\ntag ${name}\ntagger ${who} <${who}@ringi> ${Math.floor(Date.now() / 1000)} +0000\n\n${text}`}).trim()
    if (this.gitOk(['update-ref', ref, obj, old ?? ZERO]).status !== 0) fail(`${name} moved meanwhile; the next beat writes it`)
    if (this.trust === 'signed' && !Remote.pushHeartbeat(this.h, this.remote(room), who, obj, old)) this.gitOk(['update-ref', ...(old ? [ref, old, obj] : ['-d', ref, obj])])
    return obj
  }
  // The room's heartbeats as they stand: whose, on which commit, when, and what they say.
  heartbeats(room: StoredRoom): Array<{agent: string, target: string, time: number, text: string}> {
    const g12 = room.genesis.slice(0, 12)
    const tags = this.git(['for-each-ref', '--format=%(refname) %(objectname) %(objecttype)', 'refs/tags/']).split('\n')
      .map(l => l.split(' ')).filter(([ref, , type]) => type === 'tag' && Remote.heartbeatName(ref ?? '')?.genesis12 === g12)
    const objects = this.tagObjects(tags.map(([, object]) => object))
    // On a signed hub only a verified beat shows.
    const ok = (ref: string, object: string) => this.trust !== 'signed' || !Remote.verifyHeartbeat(this.h, this.remote(room), ref, object)
    return tags.flatMap(([ref, object]) => {
      const o = objects.get(object)
      return o && ok(ref, object) ? [{agent: Remote.heartbeatName(ref)!.actor, target: o.target, time: o.time, text: o.text}] : []
    })
  }
  // An annotated tag without text in its author's namespace, on the message's commit, signed on a signed hub. The
  // message's id in the name keeps it unique, so writing the same signal twice is a no-op.
  signal(room: StoredRoom, who: string, target: string, name: string): void {
    const tag = `${who}.${name}`
    const ref = `refs/tags/${tag}`
    if (this.gitOk(['rev-parse', '-q', '--verify', ref]).status === 0) {
      Remote.push(this.h, ref)
      return
    }
    const sign = Remote.sign(this.h, who, this.home)
    const key = sign[0]?.slice(2)
    this.git([...(key ? ['-c', `user.signingkey=${key}`] : []), 'tag', key ? '-s' : '-a', '-F', '-', tag, target], {input: '', env: ident(who)})
    Remote.push(this.h, ref)
  }
  // The tags named `<actor>.<signal>.<message12>`, with the objects they name.
  private tags(): Array<{ref: string, actor: string, name: string, object: string, type: string}> {
    return this.git(['for-each-ref', '--format=%(refname) %(objectname) %(objecttype)', 'refs/tags/']).split('\n').flatMap(line => {
      const [ref, object, type] = line.split(' ')
      const m = /^refs\/tags\/([a-z0-9]+(?:[_-][a-z0-9]+)*)\.([a-z][a-z0-9.-]*\.[0-9a-f]{12})$/.exec(ref ?? '')
      // A heartbeat is no signal: it is replaced on every beat, and readers judge it apart (heartbeats()).
      return m && !Remote.heartbeatName(ref) ? [{ref, actor: m[1], name: m[2], object, type}] : []
    })
  }
  // Annotated tag objects read whole, size-framed: their target, tagger and text are never split on bytes they hold.
  private tagObjects(shas: string[]): Map<string, {target: string, tagger: string, time: number, text: string}> {
    const out = new Map<string, {target: string, tagger: string, time: number, text: string}>()
    if (!shas.length) return out
    const raw = runGitRaw(this.args(['cat-file', '--batch']), this.home, Buffer.from(shas.join('\n') + '\n'))
    let at = 0
    for (const sha of shas) {
      const nl = raw.indexOf(0x0a, at)
      const [got, type, size] = raw.subarray(at, nl).toString('utf8').split(' ')
      const body = raw.subarray(nl + 1, nl + 1 + Number(size))
      at = nl + 1 + Number(size) + 1
      if (got !== sha || type !== 'tag') continue
      const split = body.indexOf('\n\n')
      const hdr = body.subarray(0, split < 0 ? body.length : split).toString('utf8')
      const text = split < 0 ? '' : body.subarray(split + 2).toString('utf8').split('-----BEGIN SSH SIGNATURE-----')[0]
      const target = /^object ([0-9a-f]+)\ntype commit$/m.exec(hdr)?.[1] ?? ''
      const tagger = /^tagger (.*?) <[^>\n]*> (\d+) [+-]\d{4}$/m.exec(hdr)
      out.set(sha, {target, tagger: tagger?.[1] ?? '', time: Number(tagger?.[2] ?? NaN), text})
    }
    return out
  }
  // Every commit of the room's branch: a signal belongs to the room whose branch holds its message.
  private commitsOf(room: StoredRoom): Set<string> {
    const tip = this.tip(room.name)
    return new Set(tip ? this.entries(room, tip).map(e => e.sha) : [])
  }
  signals(room: StoredRoom): SignalRecord[] {
    const tags = this.tags(), objects = this.tagObjects(tags.filter(t => t.type === 'tag').map(t => t.object))
    const mine = this.commitsOf(room)
    const records = tags.flatMap(t => {
      const o = objects.get(t.object)
      // Only an annotated tag on a commit is a signal; anything else points nowhere.
      if (!mine.has(o?.target || t.object)) return []
      return [{ref: t.ref, object: t.object, name: t.name, actor: t.actor, target: o?.target ?? '', tagger: o?.tagger ?? '', text: o?.text ?? ''}]
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
