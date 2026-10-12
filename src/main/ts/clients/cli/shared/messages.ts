import * as Room from '../../../core/hub/usecases/room.ts'
import {withSizes} from '../../../core/hub/usecases/room.ts'
import {asJson, render} from '../../../core/hub/usecases/view.ts'
import {bytes, fail, short, words} from '../../../lib/index.ts'
import type {Opts} from '../args.ts'
import {attachments, dump, flag, list, opt, out, textOf} from '../args.ts'
import type {Ctx} from '../context.ts'

const sendInput = (o: Opts): Room.SendInput => ({
  text: textOf(o), to: words(opt(o, 'to')), all: flag(o, 'all'), task: flag(o, 'task'),
  state: opt(o, 'state'), assign: opt(o, 'assign') ? words(opt(o, 'assign')) : undefined, roles: opt(o, 'roles'), grant: opt(o, 'grant'),
  files: list(o, 'attach').flatMap(attachments)
})

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
