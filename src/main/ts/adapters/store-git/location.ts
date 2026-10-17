// A pinned outer directory cannot authorize a Git worktree whose metadata or objects are redirected elsewhere.
import fs from 'node:fs'
import path from 'node:path'
import {fail} from '../../lib/index.ts'
import type {RoomEndpointV2} from '../../core/hub/ports/store.ts'

const directory = (at: string): void => {
  const stat = fs.lstatSync(at)
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail('git/4 repository children must be real directories; symlink/gitfile layouts are unsupported')
}
export const checkRepositoryPath = (at: string, endpoint: RoomEndpointV2): void => {
  let child = at
  for (const part of [...endpoint.store.path.split('/'), '.git']) {child = path.join(child, part); directory(child)}
  for (const part of ['objects', 'refs']) directory(path.join(child, part))
  if (fs.existsSync(path.join(child, 'commondir')) || fs.existsSync(path.join(child, 'objects/info/alternates'))) fail('git/4 linked common directories and alternate object stores are unsupported')
}
