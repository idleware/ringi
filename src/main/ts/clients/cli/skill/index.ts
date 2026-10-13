// skill: the agents' manual for this same command line (src/main/resources/skill/), installed where each agent tool
// reads skills, and removed again.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {about} from '../../../core/hub/usecases/context.ts'
import {sandboxHints, skillDirs} from '../../../core/agents/sessions/context.ts'
import {fail} from '../../../lib/index.ts'
import type {Opts} from '../args.ts'
import {out} from '../args.ts'

export const SKILL = path.join(about().resources, 'skill', 'ringi')
// Each agent tool's skill directory under the user's home; nothing is written into projects.
export const skillTargets = (): string[] => skillDirs(os.homedir())

const install = () => {
  for (const dir of skillTargets()) {
    fs.mkdirSync(dir, {recursive: true})
    fs.cpSync(SKILL, dir, {recursive: true})
    out(`installed ${dir}`)
  }
  out([`ringi's home is ${about().home}. A sandboxed agent must be allowed to write it.`, ...sandboxHints(about().home).map(h => `  ${h}`),
    'Otherwise agents re-run ringi commands with sandbox escalation, which you approve.'].join('\n'))
}
const uninstall = () => {
  for (const dir of skillTargets()) {
    if (!fs.existsSync(dir)) continue
    fs.rmSync(dir, {recursive: true})
    out(`removed ${dir}`)
  }
}
const COMMANDS = new Map<string, () => void>([['install', install], ['uninstall', uninstall]])
export const skill = (o: Opts) => {
  const run = COMMANDS.get(o._[0]) ?? fail('usage: ringi skill install | uninstall')
  run()
}
