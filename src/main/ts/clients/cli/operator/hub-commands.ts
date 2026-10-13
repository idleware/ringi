// hub-commands: `ringi hub list | create | amend`.

import fs from 'node:fs'
import * as Hubs from '../../../core/hub/usecases/hubs.ts'
import type {Opts} from '../args.ts'
import {attachments, flag, list, opt, out, textOf} from '../args.ts'

export const listHub = (_: Opts) => {
  for (const h of Hubs.hubs()) out(`${h.name.padEnd(12)} ${h.store}, ${h.trust}, ${h.contract ? `contract ${h.contract}` : 'contract only in its rooms'}, ${h.rooms} room(s)${h.remote ? `  remote ${h.remote}` : ''}  ${h.dir}`)
  return
}

export const createHub = (o: Opts) => {
  const [, arg] = o._

  const r = Hubs.create(arg ?? '', {signed: flag(o, 'signed'), url: opt(o, 'url')})
  if (!r.H.signed) return out(`created hub ${arg} (${r.H.dir})`)
  return out(`created signed hub ${arg}${r.remote ? `, its contract published to ${r.remote}` : ''}. Its root key stays on this machine (${r.rootKey}).
A room made with --url prints the invitation its agents join by, elsewhere.`)
}

export const amendHub = (o: Opts) => {
  const H = Hubs.hubOf(opt(o, 'hub'))
  const files = list(o, 'attach').flatMap(attachments).map(e => ({path: e.path, content: fs.readFileSync(e.file!)}))
  const r = Hubs.amend(H, {text: textOf(o), set: list(o, 'set'), files})
  return out(`amended hub ${H.name}: contract ${r.version}; rooms made from now on follow it, existing ones keep the contract they were made with`)
}
