// Store on git/3: an explicit contract source or one self-contained room repository.
// main holds the frozen contract; chat holds root controls and participant messages. Actor signals/telemetry are
// append-only commit streams. Reader evidence lives below refs/ringi/accepted; message files remain in chat trees.
// Signing is injected for every published commit. Repo, Branches and Marks separate storage from verification.

import fs from 'node:fs'
import path from 'node:path'
import {fail} from '../../lib/index.ts'
import {mkdirIn} from '../fs/index.ts'
import * as Remote from './remote.ts'
import {runGitRaw, splitBuf} from './run.ts'
import {messageFiles} from './files.ts'
import {init} from './repo.ts'
import {CONTROL_FILES} from './branches.ts'
import {Marks} from './marks.ts'
export {runGit} from './run.ts'
import type {Descriptor, JoinKey, Store, StoredMessage, StoredRoom} from '../../core/hub/ports/store.ts'
import {TEXT_MAX, checkOutgoing} from '../../core/hub/protocol/index.ts'
import type {Entry} from '../../core/hub/protocol/files.ts'
import type {SigningContext} from '../../core/signing/index.ts'
import {signingContext} from './remote/keys.ts'

export class GitStore extends Marks implements Store {
  readonly type = 'git'
  static create(hubDir: string, d: Descriptor, connection: string | {home: string, signing?: SigningContext}, contract: Record<string, string>, text: string): GitStore {
    const {home, signing} = typeof connection === 'string' ? {home: connection, signing: undefined} : connection
    if (d.trust === 'signed') signingContext({name: d.name, signing})
    const dir = path.join(hubDir, d.contract?.path ?? fail('no operator contract source'), '.git')
    // A signed hub's repository already exists: rootFor made it with the root key.
    if (!fs.existsSync(dir)) {
      mkdirIn(home, path.dirname(dir))
      init(dir, home)
    }
    const s = new GitStore(hubDir, d, home, signing)
    const sha = s.commit('operator', text, s.tree(null, Object.entries(contract).map(([p, c]) => ({path: p, content: c, mode: '100644'}))), [])
    d.genesis = sha
    if (!s.advance('refs/heads/main', sha, null)) fail(`hub ${d.name}: main already exists`)
    s.checkout()
    return s
  }
  // A new signed hub: the root key is generated on this machine and pinned in the descriptor.
  static rootFor(hubDir: string, d: Descriptor, home: string, signing: SigningContext): string {
    signingContext({name: d.name, signing})
    const dir = path.join(hubDir, d.contract?.path ?? fail('no operator contract source'), '.git')
    mkdirIn(home, path.dirname(dir))
    init(dir, home)
    return Remote.setupSigned({name: d.name, dir, d, signing}, d.contract?.remote).root
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
    const lsTree = (sha: string) => runGitRaw(this.args(['ls-tree', '-r', '-z', sha]), this.home)
    // The author's own messages: no control record, nothing a signed hub skips.
    const own = (sha: string, author: string, body: Buffer) => author === id && !skipped.has(sha) && !this.isControl(room, sha, id, body.toString('utf8'))
    return records.flatMap(([sha, parent, ct, rest = Buffer.alloc(0)]) => {
      const {author, body} = commits.get(sha.toString())!
      if (!own(sha.toString(), author, body)) return []
      return [{id: sha.toString(), parent: parent.toString() || null, time: Number(ct.toString()), text: body,
        ...messageFiles(body, rest, sha.toString(), x => this.isRef(x), lsTree)}]
    })
  }
  blob(file: string): {id: string, size: number} {
    const id = this.git(['hash-object', '-w', '--', file]).trim()
    return {id, size: Number(this.git(['cat-file', '-s', id]).trim())}
  }
  // One message on top of the room's branch.
  append(room: StoredRoom, who: string, text: string, entries: Entry[]): string {
    if (checkOutgoing(text, s => this.isRef(s)).trailers['ringi-files']) fail('Ringi-Files is store metadata; supply attachments instead')
    const own = entries.find(e => CONTROL_FILES.has(e.path))
    if (own) fail(`${own.path} is the room's own file; attach it under another path`)
    if (entries.length) text = `${text.trimEnd()}\nRingi-Files: ${JSON.stringify([...new Set(entries.map(e => e.path))])}\n`
    if (Buffer.byteLength(text) > TEXT_MAX) fail('attachment list makes the message exceed 64 KiB; use fewer or shorter paths')
    checkOutgoing(text, s => this.isRef(s))
    return this.onTop(room, who, text, entries)
  }
  verifyLog(room: StoredRoom, id: string, head: string): string | null {
    return this.trust === 'signed' ? Remote.verify(this.h, this.remote(room), id, head) : null
  }
  pin(room: StoredRoom, reader: string, id: string, rev: string): void {
    this.git(['update-ref', `refs/ringi/accepted/${room.genesis}/${reader}/logs/${id}`, rev])
  }
  unpin(room: StoredRoom, reader: string, id: string): void {
    this.gitOk(['update-ref', '-d', `refs/ringi/accepted/${room.genesis}/${reader}/logs/${id}`])
  }
  file(rev: string, p: string): Buffer { return runGitRaw(this.args(['show', `${rev}:${p}`]), this.home) }
  sizes(rev: string, paths: string[]): Map<string, number> {
    if (!paths.length) return new Map()
    const wanted = new Set(paths)
    return new Map(splitBuf(runGitRaw(this.args(['ls-tree', '-r', '-l', '-z', rev]), this.home), 0)
      .map(b => /^\d+ blob [0-9a-f]+ +(\d+)\t(.*)$/s.exec(b.toString('utf8'))).filter((x): x is RegExpExecArray => !!x)
      .filter(([, , p]) => wanted.has(p)).map(([, n, p]) => [p, Number(n)] as [string, number]))
  }
  admit(room: StoredRoom, who: string, key: string): string { return Remote.roomAdmit(this.h, this.remote(room), who, key) }
  joinKey(room: StoredRoom, who: string): JoinKey { return Remote.join(this.h, this.remote(room), who) }
  // A room's transport alarm is the room's, whichever author the operator forgets.
  forgetLog(room: StoredRoom, _id: string): void { Remote.forget(this.h, this.remote(room)) }
  rootRoster(): string { return Remote.rootRoster(this.h) }
}
