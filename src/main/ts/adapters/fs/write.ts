// write: writing where a sandbox may refuse, with the one message that says what to do.

import crypto from 'node:crypto'
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
// A JSON file replaced in one step: a reader sees the old file or the new one. The temporary file is made here, new,
// owner-only and never through a link, so nothing set up beside the file redirects the write.
export const writeJsonAtomic = (file: string, v: unknown): void => {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}`
  const {O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW} = fs.constants
  const fd = fs.openSync(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
  try { fs.writeFileSync(fd, JSON.stringify(v, null, 2)) } finally { fs.closeSync(fd) }
  try { fs.renameSync(tmp, file) } catch (e) { fs.rmSync(tmp, {force: true}); throw e }
}
