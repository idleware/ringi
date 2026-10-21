// composition: the one place ringi is put together when a program starts: this build, the machine's state, the store
// types, the agent tools it knows, its processes and keys. Importing it wires them into the ports (core/hub/ports,
// core/agents/ports); nothing else imports an adapter.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {fail, notesTo} from '../lib/index.ts'
import {wireHub} from '../core/hub/ports/index.ts'
import type {Build} from '../core/hub/ports/index.ts'
import {wireAgents} from '../core/agents/ports/index.ts'
import {stateFsV5} from '../adapters/state-fs/index.ts'
import {claude} from '../adapters/agent-claude/index.ts'
import {codex} from '../adapters/agent-codex/index.ts'
import {cursor} from '../adapters/agent-cursor/index.ts'
import {hostPosix} from '../adapters/host-posix/index.ts'
import {keysFile} from '../adapters/keys-file/index.ts'
import {git4Transport} from '../adapters/store-git/transport-v4.ts'
import type {TransportAuth} from '../adapters/store-git/transport.ts'
import {roomFiles} from '../adapters/location-fs/index.ts'
import {forgejoAccess} from '../adapters/access-forgejo/index.ts'
import {githubAccess} from '../adapters/access-github/index.ts'
import {giteaAccess} from '../adapters/access-gitea/index.ts'

// The package this file belongs to, run from its source (src/main/ts) or its build (target/esm).
const packageOf = (dir: string): string => fs.existsSync(path.join(dir, 'package.json')) ? dir : packageOf(path.dirname(dir))
const PACKAGE = packageOf(path.dirname(fileURLToPath(import.meta.url)))
export const build: Build = {
  version: JSON.parse(fs.readFileSync(path.join(PACKAGE, 'package.json'), 'utf8')).version,
  resources: path.join(PACKAGE, 'src', 'main', 'resources'),
}
const root = path.resolve(process.env.RINGI_HOME || path.join(os.homedir(), '.ringi'))

// How the git store reaches a room over SSH, by the reference its endpoint names: a ringi key of this machine (the
// root's `ringi-key:<hub>/operator`, an account realm's or a room's own), the same file its signatures come from, so a
// joined agent needs nothing else; `file:<path>`, an identity file; `agent:<socket>#<public key>`, a key an ssh-agent
// holds.
const auth: TransportAuth = {resolve: ref => {
  if (ref.startsWith('ringi-key:')) return {type: 'file', path: keysFile(root).custodyRef!(ref)}
  if (ref.startsWith('file:')) return {type: 'file', path: ref.slice('file:'.length)}
  const agent = /^agent:([^#]+)#(.+)$/.exec(ref)
  return agent ? {type: 'agent', socket: agent[1], publicKey: agent[2]} : fail(`no SSH identity ${ref}: ringi-key:<hub>/<agent>, file:<path> or agent:<socket>#<public key>`)
}}
// The git store signs with keys kept as files under the home, made only for a signed hub. Rooms are registered by
// address in a home of version 5 and laid out as git/4 (docs/spec/hub-2.md); an older home is not read.
const transports = {git: git4Transport(root, {signer: () => keysFile(root), auth})}
wireHub({build, state: stateFsV5({root, build}), transports, store: 'git', roomFiles, access: {forgejo: forgejoAccess, github: githubAccess, gitea: giteaAccess}})
// In the order a session is recognised by.
wireAgents({tools: [claude, codex, cursor], host: hostPosix()})
notesTo(line => { process.stderr.write(line) })
