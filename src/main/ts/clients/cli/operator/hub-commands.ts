// hub-commands: `ringi hub list | amend`.

import fs from 'node:fs'
import * as Hubs from '../../../core/hub/usecases/hubs.ts'
import * as Rooms from '../../../core/hub/usecases/rooms.ts'
import type {Opts} from '../args.ts'
import {attachments, list, opt, out, textOf} from '../args.ts'

export const listHub = (_: Opts) => {
  for (const h of Hubs.hubs()) out(`${h.name.padEnd(22)} ${h.trust}, ${h.contract ? `contract ${h.contract}` : 'contract only in its rooms'}, ${h.rooms} room(s)${h.space ? `  space ${h.space}` : ''}  ${h.dir}`)
}

// The hub of the named room, else of the current one, else `local`.
export const amendHub = (o: Opts) => {
  const H = Rooms.hubOfRoom(opt(o, 'room'))
  const files = list(o, 'attach').flatMap(attachments).map(e => ({path: e.path, content: fs.readFileSync(e.file!)}))
  const r = Hubs.amend(H, {text: textOf(o), set: list(o, 'set'), files})
  return out(`amended hub ${H.name}${H.d.access ? ` of ${H.d.access.address}` : ''}: contract ${r.version}; rooms made from now on follow it, existing ones keep the contract they were made with`)
}
