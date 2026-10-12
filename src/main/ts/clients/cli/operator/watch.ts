// watch: the headless watcher the operator starts for an agent's seat (`ringi watch <room>/<agent> --exec …`).
import {watch} from '../../../core/agents/sessions/agent.ts'
import {fail, words} from '../../../lib/index.ts'
import type {Opts} from '../args.ts'
import {flag, opt, out} from '../args.ts'

const numberOption = (o: Opts, k: string) => opt(o, k) === undefined ? undefined : Number(opt(o, k))
export const watchCommand = async (o: Opts): Promise<void> => {
  process.exitCode = await watch({
    seat: o._[0] ?? fail('usage: ringi watch <room>/<agent> --exec <cmd> [--scope <text>] [--once] [--require-grant] …'),
    exec: opt(o, 'exec') ?? fail('--exec <cmd> is required: the command that starts a headless turn'),
    hub: opt(o, 'hub'), scope: opt(o, 'scope'), once: flag(o, 'once'), requireGrant: flag(o, 'require-grant'), handoff: flag(o, 'handoff'),
    interval: numberOption(o, 'interval'), from: opt(o, 'from') ? words(opt(o, 'from')) : undefined, maxHop: numberOption(o, 'max-hop'),
    maxRuns: numberOption(o, 'max-runs'), window: numberOption(o, 'window')
  }, out)
}
