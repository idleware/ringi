// Parse one option at a time, keeping positional arguments and repeated values in order.
import {fail} from '../../lib/index.ts'
import type {Opts} from './args.ts'

const BOOLS = new Set(['task', 'peek', 'all', 'json', 'help', 'once', 'project', 'follow', 'short', 'yes', 'require-grant', 'md', 'archived', 'signed', 'repair', 'handoff', 'clear', 'published'])
const MULTI = new Set(['m', 'attach', 'set', 'drop'])
const SHORT: Record<string, string> = {m: 'm', F: 'file', n: 'n', o: 'out', h: 'help'}
type Option = {key: string, val?: string}
const option = (a: string): Option | null => {
  if (a.startsWith('--')) {
    const [key, val] = a.slice(2).split(/=(.*)/s)
    return {key, val}
  }
  if (/^-[a-zA-Z]$/.test(a)) return {key: SHORT[a[1]] ?? fail(`unknown option ${a}`)}
  return null
}
const consume = (argv: string[], o: Opts, i: number): number => {
  const parsed = option(argv[i])
  if (!parsed) {o._.push(argv[i]); return 1}
  const {key, val} = parsed
  if (BOOLS.has(key)) {o[key] = true; return 1}
  const value = val ?? argv[i + 1] ?? fail(`--${key} needs a value`)
  o[key] = MULTI.has(key) ? [...(o[key] as string[] | undefined ?? []), value] : value
  return val === undefined ? 2 : 1
}
export const parseArgs = (argv: string[]): Opts => {
  const o: Opts = {_: []}
  for (let i = 0;i < argv.length;) {
    if (argv[i] === '--') {o._.push(...argv.slice(i + 1)); break}
    i += consume(argv, o, i)
  }
  return o
}
