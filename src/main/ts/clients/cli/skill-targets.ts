import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {about} from '../../core/hub/usecases/context.ts'
import {skillDirs} from '../../core/agents/sessions/context.ts'

export const SKILL = path.join(about().resources, 'skill', 'ringi')
export const skillTargets = (project: boolean) => {
  const base = project ? process.cwd() : os.homedir()
  return skillDirs(base)
}
export const sameSkill = (dir: string): boolean => {
  try {return fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8') === fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8')}
  catch {return false}
}
