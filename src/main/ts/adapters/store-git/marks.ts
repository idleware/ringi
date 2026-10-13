// marks: tags on a room's commits. Signals are immutable annotated tags `<agent>.<signal>.<message12>`; a heartbeat is
// one mutable tag `<agent>.heartbeat.<genesis12>` per agent and room, replaced on every beat.

import * as Remote from './remote.ts'
import {signedTag} from './signing.ts'
import {ZERO, frames, runGitRaw} from './run.ts'
import {signalTags, tagObject} from './tags.ts'
import {Branches} from './branches.ts'
import type {SignalRecord, StoredRoom} from '../../core/hub/ports/store.ts'
import {fail, note} from '../../lib/index.ts'

export class Marks extends Branches {
  // The heartbeat of `who` in the room: a tag `<who>.heartbeat.<genesis12>` on the room's last commit here, its text the
  // facts of the beat (core/agents/heartbeat). Each beat replaces the object under the same name, compare-and-swap on the one it
  // read, so two writers do not overwrite each other blindly. No reader pins it; its replacement is no alarm.
  // On a signed hub the object is signed by `who` and published with the OID it replaced; a newer beat there wins, and
  // this one is taken back here (remote.ts).
  heartbeat(room: StoredRoom, who: string, target: string, text: string): string {
    const ref = Remote.heartbeatRef(who, room.genesis), name = ref.slice('refs/tags/'.length)
    const old = this.rev(`${ref}^{tag}`) ? this.git(['rev-parse', ref]).trim() : null
    const obj = this.trust === 'signed' ? Remote.makeHeartbeat(this.h, this.remote(room), who, target, text)
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
    this.git(['update-ref', ref, signedTag(this.h, who, tag, target), ZERO])
    Remote.push(this.h, ref)
  }
  // The tags named `<actor>.<signal>.<message12>`, with the objects they name; a heartbeat is no signal (heartbeats()).
  protected tags() {
    return signalTags(this.git(['for-each-ref', '--format=%(refname) %(objectname) %(objecttype)', 'refs/tags/']), ref => !!Remote.heartbeatName(ref))
  }
  // Annotated tag objects read whole (run.ts frames): their target, tagger and text are never split on bytes they hold.
  protected tagObjects(shas: string[]): Map<string, {target: string, tagger: string, time: number, text: string}> {
    if (!shas.length) return new Map()
    const raw = runGitRaw(this.args(['cat-file', '--batch']), this.home, Buffer.from(shas.join('\n') + '\n'))
    return new Map([...frames(raw, shas)].filter(([, f]) => f.type === 'tag').map(([sha, f]) => [sha, tagObject(f.body)]))
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
    if (this.trust !== 'signed') return records
    return Remote.withVerification(this.h, () => records.filter(s => {
      const why = Remote.verifySignal(this.h, this.remote(room), s.ref, s.object)
      if (why) note(`ALARM signal ${s.ref}: ${why}; quarantined and withheld`)
      return !why
    }))
  }
}
