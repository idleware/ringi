// shared: commands the operator and agents both run: messages, threads, work, signals, proposals and grants. Each
// parses its arguments, calls one app operation and prints the result.

import fs from 'node:fs'
import path from 'node:path'
import * as Budget from '../app/budget.ts'
import * as Room from '../app/room.ts'
import {checkPath, withSizes} from '../app/room.ts'
import {asJson, oneLine, render} from '../app/view.ts'
import type {TaskView} from '../app/view.ts'
import type {Checked} from '../domain/signals.ts'
import {bytes, fail, note, short, when, words} from '../lib/index.ts'
import {attachments, dump, flag, list, opt, out, textOf} from './args.ts'
import type {Opts} from './args.ts'
import type {Ctx} from './context.ts'
import type {Session} from '../app/session.ts'

const sendInput = (o: Opts): Room.SendInput => ({text: textOf(o), to: words(opt(o, 'to')), all: flag(o, 'all'), task: flag(o, 'task'),
  state: opt(o, 'state'), assign: opt(o, 'assign') ? words(opt(o, 'assign')) : undefined, roles: opt(o, 'roles'), grant: opt(o, 'grant'),
  files: list(o, 'attach').flatMap(attachments)})
const sent = (r: Room.Sent) => out(`sent ${short(r.id)} to ${r.to.join(', ')}${r.files ? ` with ${r.files} file(s)` : ''}`)

// Stages files for the actor's next message, like git add: their content is taken into the hub now. Without files it
// lists what is staged; --drop <path> and --clear take files back out.
export const add = (a: Ctx, o: Opts) => {
  if (flag(o, 'clear')) Room.unstage(a, null)
  else if (list(o, 'drop').length) Room.unstage(a, list(o, 'drop'))
  const staged = o._.length ? Room.stage(a, o._.flatMap(attachments)) : Room.staged(a)
  out(staged.length ? `staged for your next message:\n${staged.map(s => `  ${s.path} (${bytes(s.size)})`).join('\n')}` : 'nothing staged')
}
export const send = (a: Ctx, o: Opts) => sent(Room.send(a, {...sendInput(o), re: opt(o, 're')}))
export const reply = (a: Ctx, o: Opts) => sent(Room.send(a, {...sendInput(o), re: o._[0] ?? fail('usage: reply <msg> -m <text> …'), reply: true}))
export const read = (a: Ctx, o: Opts) => {
  const {all, m, replies, marks} = Room.message(a, o._[0] ?? fail('usage: read <msg>'))
  if (flag(o, 'json')) return dump(asJson(m))
  out(render(all, m, {files: () => withSizes(a.R, m)}))
  if (replies.length) out(`replies: ${replies.map(x => `${short(x.id)} (${x.from})`).join(', ')}`)
  if (marks) out(Object.entries(marks).map(([mark, who]) => `${mark} by: ${who.join(', ')}`).join('; '))
}
export const thread = (a: Ctx, o: Opts) => {
  const {all, msgs} = Room.thread(a, o._[0] ?? fail('usage: thread <msg>'))
  if (flag(o, 'json')) return dump(msgs.map(asJson))
  out(msgs.map(m => render(all, m, {files: () => withSizes(a.R, m)})).join('\n\n'))
}
export const taskLine = (t: TaskView) => {
  const roles = Object.keys(t.roles).length ? ` [${Object.entries(t.roles).map(([id, label]) => `${id}=${label}`).join(' ')}]` : ''
  return `${short(t.id)}  ${t.state.padEnd(14)} ${t.requester} → ${t.assignees.join(',') || '(open)'}${roles}${t.taken.length ? ` taken by ${t.taken.join(',')}` : ''}${t.grant ? ` grant ${short(t.grant)}` : ''}  ${when(Date.parse(t.at) / 1000).slice(5)} by ${t.by}  ${t.subject}`
}
export const tasks = (a: Ctx, o: Opts) => {
  const {views} = Room.tasks(a, {all: flag(o, 'all')})
  if (flag(o, 'json')) return dump(views)
  if (!views.length) return out(flag(o, 'all') ? 'no work' : `no open work (profile ${a.R.profile.name}; tasks --all for everything)`)
  for (const t of views) out(taskLine(t))
}
export const log = (a: Ctx, o: Opts) => {
  const msgs = Room.log(a, {agent: opt(o, 'agent'), all: flag(o, 'all'), n: Number(opt(o, 'n') ?? 20)})
  if (flag(o, 'json')) return dump(msgs.map(asJson))
  for (const m of msgs) out(oneLine(m))
}
export const cat = (a: Ctx, o: Opts) => {
  const ref = o._[0] ?? fail('usage: cat <msg> [<path>]')
  const p = o._[1] ?? (() => {
    const {m} = Room.files(a, ref)
    return m.files.length === 1 ? m.files[0].path : fail(`${short(m.id)} has ${m.files.length} files; name one: ${m.files.map(f => f.path).join(', ')}`)
  })()
  process.stdout.write(Room.files(a, ref, p).files[0].content)
}
export const get = (a: Ctx, o: Opts) => {
  const {m, files} = Room.files(a, o._[0] ?? fail('usage: get <msg> [-o <dir>]'))
  const dir = path.resolve(opt(o, 'out') ?? short(m.id))
  for (const f of files) {
    const dest = path.join(dir, checkPath(f.path))
    fs.mkdirSync(path.dirname(dest), {recursive: true})
    fs.writeFileSync(dest, f.content)
    out(dest)
  }
}
export const who = (a: Ctx) => {
  for (const x of Room.members(a)) out(`${x.id.padEnd(12)} ${x.role.padEnd(7)} ${String(x.messages).padStart(4)} msg${x.card ? `  ${x.card}` : ''}`)
}
export const signals = (a: Ctx, o: Opts) => {
  const res = Room.signals(a, {repair: flag(o, 'repair')})
  if (res.repaired !== null) out(`restored ${res.repaired} signal(s) of ${a.me}`)
  for (const x of res.alarms) note(`ALARM ${x}`)
  if (flag(o, 'json')) return dump(res.checked)
  const at = (c: Checked) => res.all.get(c.target)?.time ?? 0
  const sorted = [...res.checked].sort((x, y) => at(x) - at(y))
  const shown = flag(o, 'all') ? sorted : sorted.slice(-Number(opt(o, 'n') ?? 20))
  if (!shown.length) return out('no signals')
  for (const c of shown) out(`${short(c.target)}  ${when(at(c)).slice(5)}  ${c.actor.padEnd(10)} ${c.signal.padEnd(20)} ${c.ok ? res.all.get(c.target)?.subject ?? '' : `MISMATCH: ${c.why}`}`)
}
export const profileCmd = ({R}: Ctx, o: Opts) => {
  if (flag(o, 'json')) return dump(R.profile)
  const P = R.profile
  out(`room ${R.name} follows profile ${P.name}${P.description ? `: ${P.description}` : ''}`)
  out(`opens with Kind: ${P.opens}; states: ${P.states.join(', ')}; initial ${P.initial}; terminal ${P.terminal.join(', ')}${P.waiting ? `; waiting ${P.waiting}` : ''}`)
  for (const [k, v] of Object.entries(P.rules)) out(`  ${k.padEnd(18)} ${(v ?? []).join(', ')}`)
}

// --- decisions and budgets ---

export const propose = (a: Ctx, o: Opts) => {
  const decider = opt(o, 'decider') ?? fail('--decider <id> is required: who decides (operator, or someone with authority in the hub contract)')
  const r = Budget.propose(a, {text: textOf(o), decider, reviewers: words(opt(o, 'reviewers')), budget: opt(o, 'budget'), due: opt(o, 'due'),
    supersedes: opt(o, 'supersedes'), files: list(o, 'attach').flatMap(attachments)})
  out(`proposed ${short(r.id)} to ${r.to.join(', ') || 'the room'}; decider ${decider}${r.budget ? `, budget ${Budget.budgetText(r.budget)}` : ''}`)
}
export const stamp_ = (a: Ctx, o: Opts) => {
  const s = o._[1] ?? ''
  if (!Budget.STAMPS.includes(s)) fail(`usage: stamp <proposal> ${Budget.STAMPS.join('|')} -m <reason>`)
  const r = Budget.stamp(a, o._[0] ?? fail('name the proposal'), s, textOf(o))
  out(`stamped ${short(r.proposal.id)} ${s}: ${short(r.id)}`)
}
export const decide = (a: Ctx, o: Opts) => {
  const d = o._[1] ?? ''
  if (!Budget.DECISIONS.includes(d)) fail(`usage: decide <proposal> ${Budget.DECISIONS.join('|')} -m <reason>`)
  const r = Budget.decide(a, o._[0] ?? fail('name the proposal'), d, textOf(o))
  out(`${d} ${short(r.proposal.id)}: ${short(r.id)}${r.budget ? `; grant ${short(r.id)} with ${Budget.budgetText(r.budget)}. Work spends it with --grant ${short(r.id)}` : ''}`)
}
export const proposals = (a: Ctx, o: Opts) => {
  const {proposals: ps, views} = Budget.proposals(a, {all: flag(o, 'all')})
  if (flag(o, 'json')) return dump(views)
  if (!ps.length) return out(flag(o, 'all') ? 'no proposals' : 'no open proposals (proposals --all for everything)')
  for (const x of ps) {
    const st = x.reviewers.map(r => `${r}:${x.stamps[r]?.stamp ?? '-'}`).join(' ')
    out(`${short(x.proposal.id)}  ${x.state.padEnd(10)} ${x.proposal.from} → ${x.decider}${x.budget ? `  [${Budget.budgetText(x.budget)}]` : ''}${st ? `  ${st}` : ''}  ${x.proposal.subject}`)
  }
}
export const grants = (a: Ctx, o: Opts) => {
  const gs = Budget.grants(a)
  if (flag(o, 'json')) return dump(gs)
  if (!gs.length) return out('no grants')
  for (const g of gs) {
    const u = g.usage
    out(`${short(g.grant)}  ${g.revoked ? 'revoked ' : u.left ? 'active  ' : 'spent   '} runs ${u.runs}/${g.budget.runs}, open ${u.open}${u.uncertain ? `, uncertain ${u.uncertain}` : ''}, ${u.seconds}s used, ≤${g.budget['run-seconds']}s a run, concurrency ${g.budget.concurrency}  ${g.subject}`)
  }
}
// What the session may do on its own: the recorded scope; without one, in a room with a quorum the room's work for it,
// in any other what the operator accepts when asked.
export const scopeLine = (s: Session, quorum = false): string => s.scope
  ?? (quorum ? 'none recorded; the room\'s work for you, split with the other members' : 'none recorded; ask the operator what to accept')
// The line that keeps an agent of a room waiting for its quorum from doing anything yet.
export const waiting = (room: string, st: {quorum: number | null, agents: number}): string =>
  `waiting: room ${room} waits for a quorum of ${st.quorum} agents and has ${st.agents}; nothing to do yet, end the turn. Its work starts by itself at the quorum`
