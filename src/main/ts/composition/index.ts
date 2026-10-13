// composition: the one place ringi is put together when a program starts: this build, the machine's state, the store
// types, the agent tools it knows, its processes and keys. Importing it wires them into the ports (core/hub/ports,
// core/agents/ports); nothing else imports an adapter.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {notesTo} from '../lib/index.ts'
import {wireHub} from '../core/hub/ports/index.ts'
import type {Build} from '../core/hub/ports/index.ts'
import {wireAgents} from '../core/agents/ports/index.ts'
import {stateFs} from '../adapters/state-fs/index.ts'
import {claude} from '../adapters/agent-claude/index.ts'
import {codex} from '../adapters/agent-codex/index.ts'
import {cursor} from '../adapters/agent-cursor/index.ts'
import {hostPosix} from '../adapters/host-posix/index.ts'
import {keysFile} from '../adapters/keys-file/index.ts'
import {gitTransport} from '../adapters/store-git/transport.ts'

// The package this file belongs to, run from its source (src/main/ts) or its build (target/esm).
const packageOf = (dir: string): string => fs.existsSync(path.join(dir, 'package.json')) ? dir : packageOf(path.dirname(dir))
const PACKAGE = packageOf(path.dirname(fileURLToPath(import.meta.url)))
export const build: Build = {
  version: JSON.parse(fs.readFileSync(path.join(PACKAGE, 'package.json'), 'utf8')).version,
  resources: path.join(PACKAGE, 'src', 'main', 'resources'),
}
const root = path.resolve(process.env.RINGI_HOME || path.join(os.homedir(), '.ringi'))

// The git store signs with keys kept as files under the home, made only for a signed hub.
const transports = {git: gitTransport(root, {signer: () => keysFile(root)})}
wireHub({build, state: stateFs({root, build}), transports, store: 'git'})
// In the order a session is recognised by.
wireAgents({tools: [claude, codex, cursor], host: hostPosix()})
notesTo(line => { process.stderr.write(line) })
