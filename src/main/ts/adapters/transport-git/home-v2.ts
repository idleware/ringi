// home-v2: a home of version 2 kept each hub as a bare repository `hub/<name>.git` with its settings in git config.
// Version 3 keeps a descriptor beside the store: `hub/<name>/hub.json` and `hub/<name>/store/.git`. composition/ gives
// this step to the state adapter for version 2.

import fs from 'node:fs'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {note} from '../../lib/index.ts'
import {guardWrite} from '../fs/index.ts'
import type {LocalState} from '../../core/hub/ports/index.ts'

export const homeV2 = (state: LocalState): void => {
  const hubs = state.place(['hub'])
  for (const f of fs.readdirSync(hubs).filter(f => f.endsWith('.git'))) {
    const name = f.slice(0, -4)
    const old = path.join(hubs, f)
    const cfg = (k: string) => String(spawnSync('git', ['--git-dir', old, 'config', '--get', k], {encoding: 'utf8'}).stdout ?? '').trim()
    const signed = cfg('ringi.type') === 'remote'
    const descriptor = {schema: 'ringi-hub/2', name, trust: signed ? 'signed' : 'asserted',
      ...(signed ? {root: cfg('ringi.rootKey') || undefined, genesis: cfg('ringi.genesis') || undefined} : {}),
      store: {type: 'git', path: 'store', ...(cfg('remote.origin.url') ? {remote: cfg('remote.origin.url')} : {})}}
    const store = state.place(['hub', name, 'store'])
    guardWrite(state.root, () => fs.renameSync(old, path.join(store, '.git')))
    state.write(['hub', name, 'hub'], descriptor)
    note(`moved hub ${name} to ${path.dirname(store)} (descriptor hub.json, store/.git)`)
  }
}
