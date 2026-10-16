// Signals: one append-only stream per actor in the selected room repository.
import {Branches} from './branches.ts'
import type {SignalEvent, SignalHead, StoredRoom} from '../../core/hub/ports/store.ts'
import {fail} from '../../lib/index.ts'
import {streamName, streamRef, scanStream, signalEvents} from './remote/streams.ts'
import type {Stream} from './remote/streams.ts'
import {push} from './remote/push.ts'

export class Marks extends Branches {
  private streamAlarms = new Map<string, string>()
  private scannedStreams = new Map<string, {seen: string, chat: string, stream: Stream}>()
  private streams(): Array<{actor: string, head: string}> {
    return this.refsUnder('refs/heads/').flatMap(([ref, head]) => {
      const s = streamName(ref)
      return s ? [{actor: s.actor, head}] : []
    })
  }
  private readStream(room: StoredRoom, actor: string, head: string) {
    const ref = streamRef(actor)
    const chat = this.tip(room.name) ?? fail('room chat is missing')
    const cached = this.scannedStreams.get(ref)
    if (cached?.seen === head && cached.chat === chat) return cached.stream
    const prefix = cached && this.extends(cached.chat, chat) && this.extends(cached.stream.head, head) ? cached.stream : undefined
    const s = scanStream({H: this.h, R: this.remote(room), actor, head, prefix})
    this.scannedStreams.set(ref, {seen: head, chat, stream: s})
    if (s.why) this.streamAlarms.set(ref, `signal stream ${actor}: ${s.why}; stopped at ${s.head.slice(0, 12)}`)
    else this.streamAlarms.delete(ref)
    return s
  }
  signalHeads(_room: StoredRoom): SignalHead[] { return this.streams() }
  signals(room: StoredRoom): SignalEvent[] {
    return this.streams().flatMap(({actor, head}) => signalEvents(this.remote(room), actor, this.readStream(room, actor, head)))
  }
  pinSignals(room: StoredRoom, reader: string, actor: string, head: string): void {
    streamRef(actor)
    this.git(['update-ref', `refs/ringi/accepted/${room.genesis}/${reader}/signals/${actor}`, head])
  }
  override alarms(room: StoredRoom): string[] { return [...super.alarms(room), ...this.streamAlarms.values()] }
  private appendSignal(room: StoredRoom, who: string, target: string, signal: string): string {
    const ref = streamRef(who)
    for (let attempt = 0; attempt < 8; attempt++) {
      const current = this.room(room.name) ?? fail(`room ${room.name} is gone`)
      const old = this.rev(ref)
      let prefix: Stream | undefined
      if (old) {
        const checked = this.readStream(current, who, old)
        prefix = checked
        if (checked.why || checked.head !== old) fail(`ALARM ${ref}: ${checked.why ?? 'unaccepted dependencies'}; nothing appended`)
        if (checked.records.some(r => r.fields.get('Target') === target && r.fields.get('Signal') === signal)) {
          push(this.h, ref)
          return old
        }
      }
      const parent = old ?? room.genesis
      const tree = this.git(['rev-parse', `${parent}^{tree}`]).trim()
      const sha = this.commit(who, `Room: ${room.genesis}\nControl: ${current.head}\nTarget: ${target}\nSignal: ${signal}\n`, tree, [parent])
      const checked = scanStream({H: this.h, R: this.remote(current), actor: who, head: sha, prefix})
      if (checked.why || checked.head !== sha) fail(checked.why ?? 'stream dependencies are not accepted')
      if (this.advance(ref, sha, old)) return sha
    }
    return fail(`${ref} kept moving; retry`)
  }
  signal(room: StoredRoom, who: string, target: string, signal: string): void {
    this.appendSignal(room, who, target, signal)
  }
}
