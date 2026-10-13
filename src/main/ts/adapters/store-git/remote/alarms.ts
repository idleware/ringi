// alarms: what a rejected push left to say, kept per hub until the next sync settles it.

import fs from 'node:fs'
import path from 'node:path'
import * as C from '../../../lib/index.ts'
import * as FS from '../../fs/index.ts'
import {mkdir} from './git.ts'
import type {Handle} from './types.ts'

const pushAlarmsFile = (H: Handle): string => path.join(H.dir, 'ringi', 'push-alarms.json')

const alarmState = (text: string, label: string): Record<string, string> => {
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
    return {}
  }
}
