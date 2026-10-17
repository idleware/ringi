// Canonical filesystem object witnesses; pathname equality alone proves no continuity.
import fs from 'node:fs'
import path from 'node:path'
import {errno, fail} from '../../lib/index.ts'
// Structural witness shared by filesystem adapters; it has no domain dependency.
export type DirectoryWitness = {path: string, identity: string}

export const absolute = (value: string): string => {
  if (!path.isAbsolute(value) || value.includes('\0')) return fail('repository path must be absolute')
  if (value !== path.normalize(value)) return fail('repository path must have no empty, dot or parent components')
  return value
}
export const canonical = (value: string): DirectoryWitness | null => {
  absolute(value)
  try {
    const real = fs.realpathSync.native(value), stat = fs.statSync(real, {bigint: true})
    if (!stat.isDirectory()) return fail('repository location is not a directory')
    return {path: real, identity: [stat.dev, stat.ino, stat.birthtimeNs].join(':')}
  } catch (e) {
    if (errno(e) === 'ENOENT') return null
    throw e
  }
}
export const check = (directory: DirectoryWitness): void => {
  const found = canonical(directory.path)
  if (found?.path !== directory.path || found.identity !== directory.identity) fail('repository directory disappeared or changed identity')
}
export const protectedHome = (target: string, home: string): DirectoryWitness => {
  const found = canonical(home) ?? fail('protected home must already exist')
  const relative = path.relative(target, found.path)
  const ancestor = !relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
  if (target === path.parse(target).root || ancestor) fail('repository target is the home, its ancestor or a filesystem root')
  return found
}

export const entryExists = (at: string): boolean => {
  try { fs.lstatSync(at); return true } catch (e) { if (errno(e) === 'ENOENT') return false; throw e }
}
