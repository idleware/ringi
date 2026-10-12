import fs from 'node:fs'
import path from 'node:path'
import * as C from '../../../lib/index.ts'
import * as FS from '../../fs/index.ts'
import {git, mkdir} from './git.ts'
import type {Handle} from './types.ts'

export const pushAlarmsFile = (H: Handle): string => path.join(H.dir, 'ringi', 'push-alarms.json')

export const alarmState = (text: string, label: string): Record<string, string> => {
  const value = C.strictJson<unknown>(text, label)
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.values(value).every(v => typeof v === 'string')) C.fail(`${label}: expected an object of alarm strings`)
  return value as Record<string, string>
}

export const savePushAlarms = (H: Handle, alarms: Record<string, string>): void => {
  const file = pushAlarmsFile(H)
  mkdir(path.dirname(file))
  FS.writeJsonAtomic(file, alarms)
}

export const pushAlarms = (H: Handle): Record<string, string> => {
  const file = pushAlarmsFile(H)
  try {return alarmState(fs.readFileSync(file, 'utf8'), file)} catch (e) {
    if (C.errno(e) !== 'ENOENT') throw e
  }
  const old = git(H, ['config', '--get', 'ringi.pushAlarms'], {ok: true})
  if (old.status !== 0 && old.status !== 1) C.fail(`cannot read legacy push alarm state: ${old.stderr.trim()}`)
  const alarms = alarmState(old.status === 1 ? '{}' : old.stdout, 'legacy ringi.pushAlarms')
  savePushAlarms(H, alarms)
  if (old.status === 0) git(H, ['config', '--unset-all', 'ringi.pushAlarms'])
  return alarms
}
