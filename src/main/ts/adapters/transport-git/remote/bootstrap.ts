import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import * as C from '../../../lib/index.ts'
import type {Descriptor} from '../../../core/hub/ports/store.ts'
import {id, mkdir} from './git.ts'
import {checkUrl, keyInput} from './keys.ts'
import {command} from './process.ts'
import {sync} from './sync.ts'
import type {Handle} from './types.ts'
import {SHA} from './types.ts'

export const hubAdd = ({home, name, url, root, genesis}: {home: string, name: string, url: string, root?: string, genesis?: string}): string => {
  id(name); checkUrl(url)
  if (!root) C.fail('hub add requires --root <public-key|file> from the operator; a key advertised by the hub is not a trust anchor')
  const key = keyInput(root ?? C.fail('hub add requires --root <public-key|file>'))
  if (genesis && !SHA.test(genesis)) C.fail('--genesis must be a full commit id')
  // A hub is a descriptor (hub.json) beside its store; for a git store the repository is store/.git.
  const hubDir = path.join(home, 'hub', name)
  const dir = path.join(hubDir, 'store', '.git')
  if (fs.existsSync(hubDir)) C.fail(`hub ${name} exists`)
  mkdir(path.dirname(dir))
  const stage = path.join(home, 'hub', `.${name}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.git`)
  try {
    command('git', ['init', '--bare', '-q', '-b', 'main', stage])
    const descriptor: Descriptor = {
      schema: 'ringi-hub/2', name, trust: 'signed', root: key.line, genesis,
      store: {type: 'git', path: 'store', remote: url}
    }
    const H: Handle = {name, dir: stage, d: descriptor, bootstrap: !genesis}
    sync(H)
    fs.renameSync(stage, dir)
    fs.writeFileSync(path.join(hubDir, 'hub.json'), JSON.stringify(descriptor, null, 2) + '\n', {mode: 0o600})
    return dir
  } finally {
    if (fs.existsSync(stage)) fs.rmSync(stage, {recursive: true, force: true})
    // A failed add leaves no half-made hub behind (the directory did not exist before).
    if (!fs.existsSync(dir)) fs.rmSync(hubDir, {recursive: true, force: true})
  }
}
