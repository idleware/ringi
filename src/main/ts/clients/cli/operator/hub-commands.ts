// hub-commands: `ringi hub list | create | switch | add | amend`.

import fs from 'node:fs'
import * as Hubs from '../../../core/hub/usecases/hubs.ts'
import * as Rooms from '../../../core/hub/usecases/rooms.ts'
import {fail} from '../../../lib/index.ts'
import type {Opts} from '../args.ts'
import {attachments, flag, list, opt, out, textOf} from '../args.ts'

export const listHub = (_: Opts) => {
  for (const h of Hubs.hubs()) out(`${h.current ? '*' : ' '} ${h.name.padEnd(12)} ${h.store}, ${h.trust}, contract ${h.contract}, ${h.rooms} room(s)${h.remote ? `  remote ${h.remote}` : ''}  ${h.dir}`)
  return
}

export const createHub = (o: Opts) => {
  const [, arg] = o._

  const r = Hubs.create(arg ?? '', {signed: flag(o, 'signed'), url: opt(o, 'url')})
  if (!r.add) return out(`created hub ${arg} (${r.H.dir})`)
  return out(`created signed hub ${arg}${r.H.d.store.remote ? `, published to ${r.H.d.store.remote}` : ''}. Its root key stays on this machine (${r.rootKey}).
Give every machine that joins it, out of band:
  ${r.add}`)
}

export const switchHub = (o: Opts) => {
  const [, arg] = o._

  Hubs.use(arg ?? fail('usage: ringi hub switch <name>'))
  return out(`current hub: ${arg}; agents keep their own rooms`)
}

export const addHub = (o: Opts) => {
  const [, arg] = o._

  const H = Hubs.add(arg ?? '', o._[2] ?? '', {root: opt(o, 'root'), genesis: opt(o, 'genesis')})
  return out(`added signed hub ${arg} from ${o._[2]}: contract ${H.contract.version}, ${Rooms.rooms(H).length} room(s), root pinned`)
}

export const amendHub = (o: Opts) => {
  const H = Hubs.hubOf(opt(o, 'hub'))
  const files = list(o, 'attach').flatMap(attachments).map(e => ({path: e.path, content: fs.readFileSync(e.file!)}))
  const r = Hubs.amend(H, {text: textOf(o), set: list(o, 'set'), authority: opt(o, 'authority'), files})
  return out(`amended hub ${H.name}: contract ${r.version}; rooms keep their base until ringi room rebase-contract <room>`)
}
