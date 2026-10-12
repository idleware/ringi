// files: `cat` and `get`, a message's attached files.

import fs from 'node:fs'
import path from 'node:path'
import * as Room from '../../../core/hub/usecases/room.ts'
import {checkPath} from '../../../core/hub/usecases/room.ts'
import {fail, short} from '../../../lib/index.ts'
import type {Opts} from '../args.ts'
import {opt, out} from '../args.ts'
import type {Ctx} from '../context.ts'

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
