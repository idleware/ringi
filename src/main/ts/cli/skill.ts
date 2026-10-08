// skill: installs the agent skill for Claude Code, Codex and Cursor.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {about} from '../app/context.ts'
import {fail} from '../lib/index.ts'
import {flag, out} from './args.ts'
import type {Opts} from './args.ts'


// --- skill ---

export const SKILL = path.join(about().resources, 'skill', 'ringi')
export const skillTargets = (project: boolean) => {
  const base = project ? process.cwd() : os.homedir()
  return [path.join(base, '.claude', 'skills', 'ringi'), path.join(base, '.agents', 'skills', 'ringi')]
}
export const skill = (o: Opts) => {
  const sub = o._[0]
  const same = (dir: string) => {
    try { return fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8') === fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8') } catch { return false }
  }
  if (sub === 'install') {
    for (const dir of skillTargets(flag(o, 'project'))) {
      fs.mkdirSync(dir, {recursive: true})
      fs.cpSync(SKILL, dir, {recursive: true})
      out(`installed ${dir}`)
    }
    return out(`ringi's home is ${about().home}. A sandboxed agent must be allowed to write it; for Codex, the narrowest grant is:
  [sandbox_workspace_write]
  writable_roots = ["${about().home}"]
in ~/.codex/config.toml. Otherwise agents re-run ringi commands with sandbox escalation, which you approve.`)
  }
  if (sub === 'status') {
    for (const p of [false, true]) for (const dir of skillTargets(p)) out(`${same(dir) ? 'ok      ' : fs.existsSync(dir) ? 'outdated' : 'missing '} ${dir}`)
    return
  }
  if (sub === 'uninstall') {
    for (const dir of skillTargets(flag(o, 'project'))) {
      if (!fs.existsSync(dir)) continue
      fs.rmSync(dir, {recursive: true})
      out(`removed ${dir}`)
    }
    return
  }
  if (sub === 'show') return void process.stdout.write(fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8'))
  fail('usage: ringi skill install [--project] | uninstall [--project] | status | show')
}

