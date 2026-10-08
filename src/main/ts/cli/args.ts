// args: the command line: options, message text, files to attach, and printing to stdout.

import fs from 'node:fs'
import path from 'node:path'
import {fail} from '../lib/index.ts'
import {checkPath} from '../app/room.ts'
import type {Entry} from '../protocol/files.ts'

export const out = (s = ''): void => { process.stdout.write(s.endsWith('\n') ? s : `${s}\n`) }
export const dump = (v: unknown): void => out(JSON.stringify(v, null, 2))

// --- arguments ---

export type Opts = {_: string[], [key: string]: string | string[] | boolean | undefined}
const BOOLS = new Set(['task', 'peek', 'all', 'json', 'help', 'once', 'project', 'follow', 'short', 'yes', 'require-grant', 'md', 'archived', 'signed', 'repair', 'handoff'])
const MULTI = new Set(['m', 'attach', 'set'])
const SHORT: Record<string, string> = {m: 'm', F: 'file', n: 'n', o: 'out', h: 'help'}
export const parseArgs = (argv: string[]): Opts => {
  const o: Opts = {_: []}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    let key: string
    let val: string | undefined
    if (a === '--') {
      o._.push(...argv.slice(i + 1))
      break
    }
    if (a.startsWith('--')) [key, val] = a.slice(2).split(/=(.*)/s)
    else if (/^-[a-zA-Z]$/.test(a)) key = SHORT[a[1]] ?? fail(`unknown option ${a}`)
    else {
      o._.push(a)
      continue
    }
    if (BOOLS.has(key)) {
      o[key] = true
      continue
    }
    if (val === undefined) val = argv[++i] ?? fail(`--${key} needs a value`)
    if (MULTI.has(key)) o[key] = [...(o[key] as string[] | undefined ?? []), val]
    else o[key] = val
  }
  return o
}
export const opt = (o: Opts, key: string): string | undefined => typeof o[key] === 'string' ? o[key] as string : undefined
export const list = (o: Opts, key: string): string[] => Array.isArray(o[key]) ? o[key] as string[] : []
export const flag = (o: Opts, key: string): boolean => o[key] === true
export const textOf = (o: Opts): string => {
  const file = opt(o, 'file')
  const text = list(o, 'm').length ? list(o, 'm').join('\n\n') : file ? fs.readFileSync(file === '-' ? 0 : file, 'utf8') : ''
  return text.replace(/\r\n/g, '\n').trim() || fail('empty message: pass -m "<subject>" [-m "<body>"] or -F <file>')
}

const walk = (d: string): string[] => fs.readdirSync(d, {withFileTypes: true}).flatMap(e =>
  e.name === '.git' ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : e.isFile() ? [path.join(d, e.name)] : [])
// `<src>[:<dest>]` → entries; a directory source expands to its regular files.
export const attachments = (spec: string): Entry[] => {
  const i = spec.indexOf(':')
  const src = path.resolve(i < 0 ? spec : spec.slice(0, i))
  const dest = checkPath((i < 0 ? `files/${path.basename(src)}` : spec.slice(i + 1)).replace(/^\/+|\/+$/g, ''))
  const mode = (f: string) => fs.statSync(f).mode & 0o111 ? '100755' : '100644'
  if (!fs.statSync(src).isDirectory()) return [{path: dest, file: src, mode: mode(src)}]
  return walk(src).map(f => ({path: checkPath(`${dest}/${path.relative(src, f).split(path.sep).join('/')}`), file: f, mode: mode(f)}))
}
