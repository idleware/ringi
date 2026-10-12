// Skill installation is a sequence of filesystem steps for the selected targets.
import fs from 'node:fs'
import path from 'node:path'
import {about} from '../../core/hub/usecases/context.ts'
import {sandboxHints} from '../../core/agents/sessions/context.ts'
import {fail} from '../../lib/index.ts'
import type {Opts} from './args.ts'
import {flag, out} from './args.ts'
import {SKILL, sameSkill, skillTargets} from './skill-targets.ts'
export {SKILL, skillTargets} from './skill-targets.ts'

const install = (o: Opts) => {
  for (const dir of skillTargets(flag(o, 'project'))) {
    fs.mkdirSync(dir, {recursive: true})
    fs.cpSync(SKILL, dir, {recursive: true})
    out(`installed ${dir}`)
  }
  out([`ringi's home is ${about().home}. A sandboxed agent must be allowed to write it.`, ...sandboxHints(about().home).map(h => `  ${h}`),
    'Otherwise agents re-run ringi commands with sandbox escalation, which you approve.'].join('\n'))
}
const status = () => {
  for (const dir of [...skillTargets(false), ...skillTargets(true)]) {
    const state = sameSkill(dir) ? 'ok      ' : fs.existsSync(dir) ? 'outdated' : 'missing '
    out(`${state} ${dir}`)
  }
}
const uninstall = (o: Opts) => {
  for (const dir of skillTargets(flag(o, 'project'))) {
    if (!fs.existsSync(dir)) continue
    fs.rmSync(dir, {recursive: true})
    out(`removed ${dir}`)
  }
}
const show = () => {process.stdout.write(fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8'))}
const COMMANDS = new Map<string, (o: Opts) => void>([['install', install], ['status', status], ['uninstall', uninstall], ['show', show]])
export const skill = (o: Opts) => {
  const run = COMMANDS.get(o._[0]) ?? fail('usage: ringi skill install [--project] | uninstall [--project] | status | show')
  run(o)
}
