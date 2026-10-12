// CLI entry: parse once, then dispatch to the command surface.
import type {Opts} from './args.ts'
import {parseArgs} from './args.ts'
import {dispatch} from './commands.ts'
import {sandboxHints} from '../../core/agents/sessions/context.ts'
import {Fail, WriteDenied} from '../../lib/index.ts'

export type {Profile} from '../../core/hub/work/index.ts'
export {helpMarkdown, TABLE} from './help.ts'

// A reader that stops early (`ringi log | head`) closes the pipe: that ends the output, not the command's work.
const quietPipe = (e: NodeJS.ErrnoException) => {
  if (e.code === 'EPIPE') process.exit(process.exitCode ?? 0)
  else throw e
}
// What a failed command says: a refusal as it is (a write the host denied, with what each tool's sandbox needs to
// allow it), anything else with its stack.
export const failure = (e: unknown): string => {
  if (e instanceof WriteDenied) return [e.message, ...sandboxHints(e.where).map(h => `  ${h}`)].join('\n')
  return e instanceof Fail ? e.message : (e as Error).stack ?? String(e)
}
export const main = async (argv = process.argv.slice(2)): Promise<void> => {
  if (!process.stdout.listeners('error').includes(quietPipe)) process.stdout.on('error', quietPipe)
  const [cmd = 'help', ...rest] = argv
  const o = cmd === 'agent' ? {_: []} as Opts : parseArgs(rest)
  await dispatch(cmd, o, rest)
}
