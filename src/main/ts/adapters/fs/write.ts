// write: writing where a sandbox may refuse, with the one message that says what to do.

import fs from 'node:fs'
import {Fail, WriteDenied, errno} from '../../lib/fail.ts'

export const SANDBOX = /Operation not permitted|Permission denied|Read-only file system|EPERM|EACCES|EROFS/
export const cannotWrite = (where: string, detail: string): never => { throw new WriteDenied(where, detail) }
export const guardWrite = <T>(where: string, fn: () => T): T => {
  try { return fn() } catch (e) {
    if (e instanceof Fail) throw e
    if (['EPERM', 'EACCES', 'EROFS'].includes(errno(e) ?? '')) cannotWrite(where, `${errno(e)} on ${(e as NodeJS.ErrnoException).path ?? 'a file'}`)
    throw e
  }
}
export const mkdirIn = (where: string, d: string): void => { guardWrite(where, () => fs.mkdirSync(d, {recursive: true, mode: 0o700})) }
// A JSON file replaced in one step: a reader sees the old file or the new one.
export const writeJsonAtomic = (file: string, v: unknown): void => {
  const tmp = `${file}.${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2))
  fs.renameSync(tmp, file)
}
