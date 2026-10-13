// Signals and telemetry: one append-only stream per actor in the selected room repository.
import {Branches} from './branches.ts'
import type {SignalEvent, SignalHead, StoredRoom} from '../../core/hub/ports/store.ts'
import {fail} from '../../lib/index.ts'
import {streamName, streamRef, scanStream, signalEvents} from './remote/streams.ts'
import type {Stream, StreamKind} from './remote/streams.ts'
import {heartbeatBody} from './remote/heartbeat-facts.ts'
import {push} from './remote/push.ts'

export class Marks extends Branches {
  private streamAlarms = new Map<string, string>()
  private scannedStreams = new Map<string, {seen: string, chat: string, stream: Stream}>()
  private streams(_room: StoredRoom, kind: StreamKind): Array<{actor: string, head: string}> {
    return this.refsUnder('refs/heads/').flatMap(([ref, head]) => {
      const s = streamName(ref)
      return s?.kind === kind ? [{actor: s.actor, head}] : []
    })
  }
  private readStream(room: StoredRoom, actor: string, kind: StreamKind, head: string) {
    const ref = streamRef(actor, kind)
    const chat = this.tip(room.name) ?? fail('room chat is missing')
    const cached = this.scannedStreams.get(ref)
    if (cached?.seen === head && cached.chat === chat) return cached.stream
    const prefix = cached && this.extends(cached.chat, chat) && this.extends(cached.stream.head, head) ? cached.stream : undefined
    const s = scanStream({H: this.h, R: this.remote(room), actor, kind, head, prefix})
    // Telemetry has no domain fold: keep only its latest valid facts in this handle, without pruning Git history.
    if (kind === 'telemetry') s.records = s.records.slice(-1)
    this.scannedStreams.set(ref, {seen: head, chat, stream: s})
    if (s.why) this.streamAlarms.set(ref, `signal stream ${actor}: ${s.why}; stopped at ${s.head.slice(0, 12)}`)
    else this.streamAlarms.delete(ref)
    return s
  }
  signalHeads(room: StoredRoom): SignalHead[] { return this.streams(room, 'signals') }
  signals(room: StoredRoom): SignalEvent[] {
    return this.streams(room, 'signals').flatMap(({actor, head}) => signalEvents(this.remote(room), actor, this.readStream(room, actor, 'signals', head)))
  }
  pinSignals(room: StoredRoom, reader: string, actor: string, head: string): void {
    streamRef(actor, 'signals')
    this.git(['update-ref', `refs/ringi/accepted/${room.genesis}/${reader}/signals/${actor}`, head])
  }
  override alarms(room: StoredRoom): string[] { return [...super.alarms(room), ...this.streamAlarms.values()] }
  private appendStream(room: StoredRoom, who: string, kind: StreamKind, body: (control: string) => string, tuple?: {target: string, signal: string}): string {
    const ref = streamRef(who, kind)
    for (let attempt = 0; attempt < 8; attempt++) {
      const current = this.room(room.name) ?? fail(`room ${room.name} is gone`)
      const old = this.rev(ref)
      let prefix: Stream | undefined
      if (old) {
        const checked = this.readStream(current, who, kind, old)
        prefix = checked
        if (checked.why || checked.head !== old) fail(`ALARM ${ref}: ${checked.why ?? 'unaccepted dependencies'}; nothing appended`)
        if (tuple && checked.records.some(r => r.fields.get('Target') === tuple.target && r.fields.get('Signal') === tuple.signal)) {
          push(this.h, ref)
          return old
        }
      }
      const parent = old ?? room.genesis
      const tree = this.git(['rev-parse', `${parent}^{tree}`]).trim()
      const sha = this.commit(who, body(current.head), tree, [parent])
      const checked = scanStream({H: this.h, R: this.remote(current), actor: who, kind, head: sha, prefix})
      if (checked.why || checked.head !== sha) fail(checked.why ?? 'stream dependencies are not accepted')
      if (this.advance(ref, sha, old)) return sha
    }
    return fail(`${ref} kept moving; retry`)
  }
  signal(room: StoredRoom, who: string, target: string, signal: string): void {
    this.appendStream(room, who, 'signals', control => `Room: ${room.genesis}\nControl: ${control}\nTarget: ${target}\nSignal: ${signal}\n`, {target, signal})
  }
  heartbeat(room: StoredRoom, who: string, target: string, text: string): string {
    const body = /^Room:/m.test(text) ? text : `${text.trimEnd()}\nRoom: ${room.genesis}\n`
    if (heartbeatBody(body) !== room.genesis) fail('heartbeat names another room')
    return this.appendStream(room, who, 'telemetry', control => `${body.trimEnd()}\nControl: ${control}\nTarget: ${target}\n`)
  }
  heartbeats(room: StoredRoom): Array<{agent: string, target: string, time: number, text: string}> {
    return this.streams(room, 'telemetry').flatMap(({actor, head}) => {
      const latest = this.readStream(room, actor, 'telemetry', head).records.at(-1)
      return latest ? [{agent: actor, target: latest.fields.get('Target')!, time: latest.raw.time, text: latest.raw.text}] : []
    })
  }
}
