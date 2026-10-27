// files: `cat` and `get`, a message's attached files.

import fs from 'node:fs'
import path from 'node:path'
import * as Room from '../../../core/hub/usecases/room.ts'
import {checkPath} from '../../../core/hub/usecases/room.ts'
import {fail, short, shown} from '../../../lib/index.ts'
import type {Opts} from '../args.ts'
import {opt, out} from '../args.ts'
import type {Ctx} from '../context.ts'

export const cat = (a: Ctx, o: Opts) => {
  const ref = o._[0] ?? fail('usage: cat <msg> [<path>]')
  const p = o._[1] ?? (() => {
    const {m} = Room.files(a, ref)
    return m.files.length === 1 ? m.files[0].path : fail(`${short(m.id)} has ${m.files.length} files; name one: ${m.files.map(f => f.path).join(', ')}`)
  })()
  const content = Room.files(a, ref, p).files[0].content
  // A peer's bytes on a terminal: its control sequences shown, not obeyed; a pipe or a file gets the bytes as they are.
  process.stdout.write(process.stdout.isTTY ? shown(Buffer.from(content).toString('utf8')) : content)
}

// A peer chooses the paths, so they land only in a directory made here for them: never one that exists, never over a
// file, never through a link. A process that swaps directories under it while it writes is beyond this.
const fresh = (dir: string) => {
  fs.mkdirSync(path.dirname(dir), {recursive: true})
  try { fs.mkdirSync(dir) } catch (e) {
    fail((e as NodeJS.ErrnoException).code === 'EEXIST' ? `${dir} exists; get writes into a new directory: name one with -o` : (e as Error).message)
  }
}
const create = (dest: string, content: Buffer | string) => {
  const {O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW} = fs.constants
  const fd = fs.openSync(dest, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o644)
  try { fs.writeFileSync(fd, content) } finally { fs.closeSync(fd) }
}
export const get = (a: Ctx, o: Opts) => {
  const {m, files} = Room.files(a, o._[0] ?? fail('usage: get <msg> [-o <dir>]'))
  const dir = path.resolve(opt(o, 'out') ?? short(m.id))
  fresh(dir)
  for (const f of files) {
    const dest = path.join(dir, checkPath(f.path))
    fs.mkdirSync(path.dirname(dest), {recursive: true})
    create(dest, f.content)
    out(dest)
  }
}
