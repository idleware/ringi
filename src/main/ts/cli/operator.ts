// operator: what the human runs in a terminal: where things stand, sessions, hubs and rooms. Each command parses its
// arguments, calls app operations and prints the result.

import fs from 'node:fs'
import * as Hubs from '../app/hubs.ts'
import * as Heartbeat from '../app/heartbeat.ts'
import * as Overview from '../app/overview.ts'
import type {SessionView} from '../app/overview.ts'
import * as Rooms from '../app/rooms.ts'
import {oneLine, render} from '../app/view.ts'
import {config} from '../app/context.ts'
import {withSizes} from '../app/room.ts'
import {fail, short, sleep} from '../lib/index.ts'
import type {All, Message} from '../protocol/index.ts'
import {attachments, dump, flag, list, opt, out, textOf} from './args.ts'
import type {Opts} from './args.ts'
import {taskLine} from './shared.ts'

// --- where things stand, sessions, forget ---

export const sessionLine = (s: SessionView) => `${s.agent.padEnd(12)} ${s.liveness.padEnd(8)} ${(s.product ?? '?').padEnd(7)} ${s.handle}${s.scope ? `  scope: ${s.scope}` : ''}`
export const where = async (o: Opts) => {
  const H = Hubs.hubOf(opt(o, 'hub'))
  const w = Overview.where(H, opt(o, 'room') ?? config().room)
  out(`hub ${H.name}: ${H.d.store.type} store, ${H.contract.trust} senders, contract ${H.contract.version}, protocol ${H.contract.protocol}${H.contract.capabilities?.length ? `, ${H.contract.capabilities.join(' ')}` : ''}`)
  const R = w.room
  if (!R) return out('no current room: ringi room create <id> | ringi room switch <id>')
  const agents = Object.values(R.members).filter(m => m.role !== 'root').length
  out(`room ${R.name}${R.archived ? ' (archived, read-only)' : ''}, genesis ${short(R.genesis)}, profile ${R.profile.name}; members: ${Object.entries(R.members).map(([id, i]) => i.role === 'root' ? `${id} (root)` : id).join(', ')}`
    + (R.quorum === null ? '' : agents >= R.quorum ? `; started at its quorum of ${R.quorum} agents` : `; waiting for a quorum of ${R.quorum} agents, has ${agents}`))
  out(w.sessions.length ? `sessions:\n${w.sessions.map(s => `  ${sessionLine(s)}`).join('\n')}` : 'sessions: none joined')
  out(w.work.length ? `open work:\n${w.work.map(t => `  ${taskLine(t)}`).join('\n')}` : 'open work: none')
  if (w.proposals.length) out(`open proposals:\n${w.proposals.map(x => `  ${short(x.proposal.id)} ${x.state} → ${x.decider}  ${x.proposal.subject}`).join('\n')}`)
  const n = Number(opt(o, 'n') ?? (flag(o, 'short') ? 10 : 5))
  out(`last ${Math.min(n, w.messages.length)} of ${w.messages.length} messages:`)
  const show = (all: All, m: Message) => out(flag(o, 'short') ? `  ${oneLine(m)}` : `\n${render(all, m, {max: 2000, files: () => withSizes(R, m)})}`)
  for (const m of w.messages.slice(-n)) show(w.all, m)
  if (!flag(o, 'follow')) return
  out('following; new messages appear as they land (Ctrl-C to stop)')
  const seen = new Set(w.all.keys())
  for (;;) {
    await sleep(Number(opt(o, 'interval') ?? 2) * 1000)
    const now = Overview.arrived(H, R, seen)
    for (const m of now.messages) show(now.all, m)
  }
}
// Each session's pulse on this machine, judged without the model.
export const heartbeats = async (o: Opts) => {
  if (flag(o, 'published')) {
    const R = Rooms.roomIn(Hubs.hubOf(opt(o, 'hub')), opt(o, 'room'))
    const hs = Heartbeat.published(R)
    if (flag(o, 'json')) return dump(hs)
    if (!hs.length) return out(`no heartbeats in ${R.name}`)
    for (const h of hs) out(`${h.agent.padEnd(12)} ${(h.waits ? `${h.state} (${h.waits})` : h.state).padEnd(22)} ${h.age}s ago${h.overdue ? ', overdue' : ''}  on ${short(h.target)}`)
    return
  }
  const ps = await Heartbeat.heartbeats()
  if (flag(o, 'json')) return dump(ps)
  if (!ps.length) return out('no sessions')
  for (const {session: s, tool, beat: b} of ps) {
    const state = b.waits ? `${b.state} (${b.waits})` : b.state
    out(`${s.agent.padEnd(12)} ${`${s.hub}/${s.room}`.padEnd(24)} ${state.padEnd(22)} alive ${b.alive === null ? '?' : b.alive ? 'yes' : 'no'}  quiet ${b.quiet}s${b.cpu === null ? '' : `  cpu ${b.cpu.toFixed(1)}s`}  ${tool}  ${s.handle}`)
  }
}
// The process that beats for every session here; `join` and `continue` start it.
export const pulse = async (o: Opts) => {
  process.exitCode = await Heartbeat.pulse({every: Number(opt(o, 'beat') ?? 30), once: flag(o, 'once'), log: s => process.stderr.write(`ringi: ${s}\n`)})
}
export const sessions = (o: Opts) => {
  if (o._[0] === 'forget') {
    const handle = o._[1] ?? fail('usage: ringi sessions forget <handle>')
    Overview.forgetSession(handle)
    return out(`forgot session ${handle}; its seat is free`)
  }
  const ss = Overview.sessions()
  if (flag(o, 'json')) return dump(ss)
  if (!ss.length) return out('no sessions')
  for (const s of ss) out(`${s.hub}/${s.room}  ${sessionLine(s)}`)
}
export const forget = (o: Opts) => {
  const [name, id] = (o._[0] ?? '').split('/')
  if (!name || !id) fail('usage: ringi forget <room>/<log>')
  const H = Hubs.hubOf(opt(o, 'hub'))
  const n = Rooms.forgetLog(H, Rooms.roomIn(H, name), id)
  out(`forgot the accepted history of ${name}/${id} for ${n} reader(s); the next read accepts what is there now`)
}

// --- hubs and rooms ---

export const hub = (o: Opts) => {
  const [sub, arg] = o._
  if (!sub || sub === 'list') {
    for (const h of Hubs.hubs()) out(`${h.current ? '*' : ' '} ${h.name.padEnd(12)} ${h.store}, ${h.trust}, contract ${h.contract}, ${h.rooms} room(s)${h.remote ? `  remote ${h.remote}` : ''}  ${h.dir}`)
    return
  }
  if (sub === 'create') {
    const r = Hubs.create(arg ?? '', {signed: flag(o, 'signed'), url: opt(o, 'url')})
    if (!r.add) return out(`created hub ${arg} (${r.H.dir})`)
    return out(`created signed hub ${arg}${r.H.d.store.remote ? `, published to ${r.H.d.store.remote}` : ''}. Its root key stays on this machine (${r.rootKey}).
Give every machine that joins it, out of band:
  ${r.add}`)
  }
  if (sub === 'switch') {
    Hubs.use(arg ?? fail('usage: ringi hub switch <name>'))
    return out(`current hub: ${arg}; agents keep their own rooms`)
  }
  if (sub === 'add') {
    const H = Hubs.add(arg ?? '', o._[2] ?? '', {root: opt(o, 'root'), genesis: opt(o, 'genesis')})
    return out(`added signed hub ${arg} from ${o._[2]}: contract ${H.contract.version}, ${Rooms.rooms(H).length} room(s), root pinned`)
  }
  if (sub === 'amend') {
    const H = Hubs.hubOf(opt(o, 'hub'))
    const files = list(o, 'attach').flatMap(attachments).map(e => ({path: e.path, content: fs.readFileSync(e.file!)}))
    const r = Hubs.amend(H, {text: textOf(o), set: list(o, 'set'), authority: opt(o, 'authority'), files})
    return out(`amended hub ${H.name}: contract ${r.version}; rooms keep their base until ringi room rebase-contract <room>`)
  }
  fail(`unknown: hub ${sub}`)
}
export const roomCmd = (o: Opts) => {
  const [sub, arg] = o._
  const H = Hubs.hubOf(opt(o, 'hub'))
  if (!sub || sub === 'list') {
    const rs = Rooms.rooms(H, {archived: flag(o, 'archived')})
    for (const r of rs.filter(r => !r.archived)) out(`${r.current ? '*' : ' '} ${r.name.padEnd(16)} ${r.members} member(s), ${r.active} active session(s), profile ${r.profile}  genesis ${short(r.genesis)}`)
    for (const r of rs.filter(r => r.archived)) out(`  ${r.name.padEnd(16)} archived, read-only`)
    if (!rs.length && !flag(o, 'archived')) out(`no rooms in hub ${H.name}: ringi room create <id>`)
    return
  }
  if (sub === 'create') {
    const quorum = opt(o, 'quorum')
    const r = Rooms.create(H, arg ?? '', {profile: opt(o, 'profile'), quorum: quorum === undefined ? undefined : Number(quorum)})
    if (quorum !== undefined) return out(`created room ${arg} in hub ${H.name} with profile ${r.profile}; it is the current room. Its work starts by itself at a quorum of ${quorum} agent(s): in each chat that should take part, say "join ${arg} as <id>"`)
    return out(`created room ${arg} in hub ${H.name} with profile ${r.profile}; it is the current room. In each chat that should take part, say: "join ${arg} as <id>; <what to accept>"`)
  }
  if (sub === 'migrate') {
    const rev = Rooms.migrate(H, arg ?? fail('usage: ringi room migrate <id>'))
    return out(`room ${arg} uses one branch; its genesis, message ids and session bindings are kept (${short(rev)})`)
  }
  if (sub === 'switch') {
    const R = Rooms.use(H, arg ?? fail('usage: ringi room switch <id>'))
    return out(`current room: ${H.name}/${R.name}; agents keep their own rooms`)
  }
  if (sub === 'admit') {
    const R = Rooms.roomIn(H, opt(o, 'room'))
    Rooms.admit(H, R, arg ?? fail('usage: ringi room admit <agent> <public key|file>'), o._[2] ?? fail('usage: ringi room admit <agent> <public key|file>'))
    return out(`admitted ${arg} to ${H.name}/${R.name}: its signed messages are accepted from now on; it can join`)
  }
  if (sub === 'remove') {
    const R = Rooms.roomIn(H, opt(o, 'room'))
    Rooms.remove(H, R, arg ?? fail('usage: ringi room remove <agent>'))
    return out(`removed ${arg} from ${R.name}: it can no longer write or be woken there; returning needs a fresh join`)
  }
  if (sub === 'archive') {
    // Without an id, the room of the current context.
    const R = Rooms.roomIn(H, arg ?? opt(o, 'room'))
    const name = Rooms.archive(H, R)
    return out(`archived ${R.name} as ${name}: read-only, wakes nobody; its sessions end. Read it with --room ${name}`)
  }
  if (sub === 'delete') {
    const R = Rooms.roomIn(H, arg ?? opt(o, 'room'))
    if (!flag(o, 'yes')) fail(`deleting ${R.name} in hub ${H.name} erases it and everything kept for it, for good. Run again with --yes, or archive it instead`)
    Rooms.erase(H, R)
    return out(`deleted room ${R.name}: its branch, signals, pins, evidence and readers' state. Sessions bound to it leave it on their next turn`)
  }
  if (sub === 'rebase-contract') {
    const R = Rooms.roomIn(H, arg ?? fail('usage: ringi room rebase-contract <id>'))
    Rooms.rebase(H, R)
    return out(`room ${R.name} now follows the hub contract at ${short(H.main)} (${H.contract.version})`)
  }
  fail(`unknown: room ${sub}`)
}
