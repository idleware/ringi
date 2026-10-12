// hub: `ringi hub <subcommand>`, by its table (hub-commands.ts).

import {fail} from '../../../lib/index.ts'
import type {Opts} from '../args.ts'
import {addHub, amendHub, createHub, listHub, switchHub} from './hub-commands.ts'

const COMMANDS = new Map<string, (o: Opts) => void>([['list', listHub], ['create', createHub], ['switch', switchHub], ['add', addHub], ['amend', amendHub]])
export const hub = (o: Opts) => {
  const [sub] = o._
  const run = COMMANDS.get(sub || 'list') ?? fail(`unknown: hub ${sub}`)
  run(o)
}
