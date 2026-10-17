// hub: `ringi hub <subcommand>`, by its table (hub-commands.ts).

import {fail} from '../../../lib/index.ts'
import type {Opts} from '../args.ts'
import {amendHub, listHub} from './hub-commands.ts'

const COMMANDS = new Map<string, (o: Opts) => void | Promise<void>>([['list', listHub], ['amend', amendHub]])
export const hub = (o: Opts) => {
  const [sub] = o._
  const run = COMMANDS.get(sub || 'list') ?? fail(`unknown: hub ${sub}`)
  return run(o)
}
