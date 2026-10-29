// branches: a room is one linear branch from its genesis. What its commits are (messages or control records), the
// room's control files, and the room's life: create, delete.

import {fail} from '../../lib/index.ts'
import * as Remote from './remote.ts'
import {ZERO} from './run.ts'
import {Repo} from './repo.ts'
import type {Roster, StoredRoom} from '../../core/hub/ports/store.ts'
import {parse} from '../../core/hub/protocol/index.ts'
import type {Entry} from '../../core/hub/protocol/files.ts'

// The root's principal, and the files only its control records may change.
const ROOT = 'operator'
export const CONTROL_FILES = new Set(['ROOM.md', 'members.json', 'profile.json', 'allowed_signers'])
// One commit of a room's branch: who wrote it, and whether it is a control record.
type Entry_ = {sha: string, author: string, text: string, control: boolean, skipped?: string}
type Named = Pick<StoredRoom, 'name' | 'genesis'>

export class Branches extends Repo {
  protected ref(_name: string) { return 'refs/heads/chat' }
  protected tip(name: string) { return this.rev(this.ref(name)) }
  // One repository holds one chat. Its logical name is pinned by the local endpoint.
  roomNames(): string[] {
    const endpoint = this.h.endpoint
    return endpoint && this.rev('refs/heads/chat') ? [endpoint.name] : []
  }
  // A control record: the room's genesis, or a root commit of Kind: room.
  protected isControl(room: Pick<StoredRoom, 'genesis'>, sha: string, author: string, text: string): boolean {
    return sha === room.genesis || (author === ROOT && parse(text, x => this.isRef(x)).kind === 'room')
  }
  // The room's branch, oldest first, from its genesis. The last scan of each room is kept and grown by what the tip
  // added on top of it.
  protected scanned = new Map<string, {tip: string, entries: Entry_[]}>()
  protected entries(room: Named, tip: string): Entry_[] {
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
  protected judged(room: Named, tip: string, entries: Entry_[]): Entry_[] {
    if (this.trust !== 'signed' && this.h.layout !== 'git/4') return entries
    const b = Remote.branch(this.h, {name: room.name, ref: this.ref(room.name), genesis: room.genesis}, tip)
    const control = new Set(b.control)
    return entries.map(e => ({...e, control: control.has(e.sha),
      skipped: control.has(e.sha) || b.authors.has(e.sha) ? undefined : b.skipped.get(e.sha) ?? 'not on the room\'s branch'}))
  }
  protected scan(room: Pick<StoredRoom, 'genesis'>, tip: string, after?: string): Array<Entry_ & {parent: string}> {
    const shas = this.git(['rev-list', '--topo-order', '--reverse', tip, '--not', after ?? `${room.genesis}^@`]).trim().split('\n').filter(Boolean)
    let parent = after ?? this.rev(`${room.genesis}^`) ?? fail('room has no contract parent')
    return Remote.readCommits(this.h, shas).map(c => {
      if (c.parents.length !== 1 || c.parents[0] !== parent) fail('ALARM room chat is not one linear history')
      parent = c.sha
      const text = c.body.toString('utf8')
      if (c.sha === room.genesis && (c.author !== ROOT || parse(text, x => this.isRef(x)).kind !== 'room')) fail('ALARM room genesis is not a root control')
      return {sha: c.sha, parent: c.parents[0], author: c.author, text, control: this.isControl(room, c.sha, c.author, text)}
    })
  }
  room(name: string): StoredRoom | null {
    if (!this.h.endpoint || this.h.endpoint.name !== name) return null
    const ref = this.ref(name)
    const tip = this.tip(name)
    if (!tip) return null
    const genesis = this.git(['rev-list', '--first-parent', '--reverse', tip, '^refs/heads/main']).split('\n')[0]
      || this.git(['rev-list', '--first-parent', '--reverse', tip]).split('\n').filter(Boolean).at(-1)!
    if (this.h.endpoint.genesis && genesis !== this.h.endpoint.genesis) fail(`ALARM room ${name}: changed genesis`)
    if (this.h.remoteAlarms?.[ref]) fail(`ALARM ${this.h.remoteAlarms[ref]}; room ${name} is quarantined`)
    const control = this.entries({name, genesis}, tip).filter(e => e.control).map(e => ({rev: e.sha, text: e.text}))
    return {name, head: control.at(-1)!.rev, genesis, tip, base: this.rev(`${genesis}^`) ?? ZERO, control}
  }
  // Control files are read at a control record, never at the branch's tip.
  controlFile(room: StoredRoom, name: string, rev?: string): string | null {
    return this.fileAt(rev ?? room.head, name)
  }
  createRoom(name: string, who: string, text: string, files: Record<string, string>): string {
    const ref = this.ref(name)
    const endpoint = this.h.endpoint ?? fail('createRoom requires its explicit endpoint')
    if (endpoint.name !== name) fail('createRoom requires its named endpoint')
    if (this.rev(ref)) fail(`room ${name} exists in hub ${this.d.name}`)
    const sha = this.commit(who, text, this.tree(null, Object.entries(files).map(([p, c]) => ({path: p, content: c, mode: '100644'}))), [this.contractHead()])
    endpoint.genesis = sha
    if (!this.advance(ref, sha, null)) fail(`room ${name} was created meanwhile`)
    return sha
  }
  // A control record on top of the branch: the control files come from the last control record, never from the tip,
  // and the messages' files are kept.
  updateControl(room: StoredRoom, who: string, text: string, files: Record<string, string>): string {
    const kept = [...CONTROL_FILES].flatMap(n => { const c = this.controlFile(room, n); return c === null ? [] : [[n, c] as const] })
    const all = {...Object.fromEntries(kept), ...files}
    return this.onTop(room, who, text, Object.entries(all).map(([p, c]) => ({path: p, content: c, mode: '100644'})), [...CONTROL_FILES])
  }
  protected refsUnder(prefix: string): Array<[string, string]> {
    return this.git(['for-each-ref', '--format=%(refname) %(objectname)', prefix]).split('\n').filter(Boolean).map(l => l.split(' ') as [string, string])
  }
  protected remote(room: StoredRoom): Remote.Room {
    return {name: room.name, ref: this.ref(room.name), head: room.head, genesis: room.genesis}
  }
  roster(room: StoredRoom): Roster | null {
    if (this.trust !== 'signed') return null
    const v = Remote.verifyRoom(this.h, this.remote(room))
    return {members: v.members, signers: v.entries}
  }
  // Logs are read at the branch's live tip, as a reader sees the room now.
  protected live(room: StoredRoom): Entry_[] {
    const tip = this.tip(room.name)
    return tip ? this.entries(room, tip).filter(e => !e.control && !e.skipped) : []
  }
  // What a signed hub skips in the room's branch, as alarms; the room reads on without it.
  alarms(room: StoredRoom): string[] {
    const tip = this.tip(room.name)
    return tip ? this.entries(room, tip).filter(e => e.skipped).map(e => `commit ${e.sha.slice(0, 12)} by ${e.author || '(none)'}: ${e.skipped}`) : []
  }
  // A commit on the branch's tip, compare-and-swap: when another writer got there first, it is made again on the new tip.
  protected onTop(room: StoredRoom, who: string, text: string, entries: Entry[], drop: string[] = []): string {
    const ref = this.ref(room.name)
    for (let i = 0; i < 8; i++) {
      const tip = this.rev(ref) ?? fail(`room ${room.name} is gone`)
      Remote.requireActive(this.h, this.remote(room), who)
      if (drop.length && this.room(room.name)?.head !== room.head) fail('room control moved while writing; retry the operation')
      const tree = entries.length || drop.length ? this.tree(`${tip}^{tree}`, entries, drop) : this.git(['rev-parse', `${tip}^{tree}`]).trim()
      const sha = this.commit(who, text, tree, [tip])
      if (this.advance(ref, sha, tip)) return sha
    }
    return fail(`room ${room.name} kept moving while writing; retry`)
  }
  // Every commit of the room's branch: a signal belongs to the room whose branch holds its message.
  protected commitsOf(room: StoredRoom): Set<string> {
    const tip = this.tip(room.name)
    return new Set(tip ? this.entries(room, tip).map(e => e.sha) : [])
  }
}
