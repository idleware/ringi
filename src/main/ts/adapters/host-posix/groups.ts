// groups: a turn's POSIX group is settled once every observed member is a zombie; failed probes stay conservative.

import fs from 'node:fs'
import {spawnSync} from 'node:child_process'
import {groupRunning, procMember, psMember} from './group-state.ts'
import type {GroupMember} from './group-state.ts'

const exists = (group: number): boolean => {
  try { process.kill(-group, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH' }
}
const procMembers = (): Array<GroupMember | null> | null => {
  try {
    return fs.readdirSync('/proc').filter(p => /^\d+$/.test(p)).flatMap(pid => {
      try { return [procMember(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'))] } catch (e) {
        return (e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ESRCH' ? [] : [null]
      }
    })
  } catch { return null }
}
const psMembers = (): Array<GroupMember | null> | null => {
  const result = spawnSync('ps', ['-A', '-o', 'pgid=,stat='], {encoding: 'utf8', timeout: 1000})
  return result.status === 0 ? result.stdout.split('\n').filter(line => line.trim()).map(psMember) : null
}
export const groupAlive = (group: number): boolean => {
  if (!exists(group)) return false
  const proc = process.platform === 'linux' ? procMembers() : null
  const known = proc && groupRunning(group, proc)
  if (known !== null) return known
  const rows = psMembers(), observed = rows && groupRunning(group, rows)
  return observed ?? exists(group)
}
