// Repository directory identity and exclusive creation. Contained recursive purge needs a stronger OS primitive.
import fs from 'node:fs'
import path from 'node:path'
import {fail} from '../../lib/index.ts'
import type {RoomDirectory, RoomFiles, RoomReceipt} from '../../core/hub/ports/location.ts'
import {guardWrite} from '../fs/write.ts'
import {absolute, canonical, check, protectedHome} from '../fs/directory.ts'
import {recordAllocation, planQuarantine, quarantine} from './managed-room.ts'

const createLeaf = (value: string, home: string): RoomDirectory => guardWrite(value, () => {
  absolute(value)
  const parent = canonical(path.dirname(value)) ?? fail('repository parent must already exist')
  const target = path.join(parent.path, path.basename(value))
  const pinnedHome = protectedHome(target, home)
  check(parent); check(pinnedHome)
  fs.mkdirSync(target, {mode: 0o700})
  check(parent); check(pinnedHome)
  const directory = canonical(target) ?? fail('created repository directory disappeared')
  recordAllocation(directory, pinnedHome)
  return directory
})
const purge = (receipt: RoomReceipt, home: string): void => {
  check(receipt.directory)
  protectedHome(receipt.directory.path, home)
  fail('contained recursive repository purge is unsupported by this filesystem adapter; repository and local registration are retained')
}

export const roomFiles: RoomFiles = {canonical, createLeaf, check, purge, planQuarantine, quarantine}
