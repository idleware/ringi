import * as C from '../../../lib/index.ts'
import * as P from '../../../core/hub/protocol/index.ts'
import {branchData} from './branch.ts'
import {promote, reason, refs, rev} from './git.ts'
import type {Handle, Room} from './types.ts'
import {ACCEPT, TRACK} from './types.ts'

export type RoomsIndex = {byGenesis: Map<string, Room>, byTarget: Map<string, Room>}
export const syncRooms = (H: Handle, fetched: Map<string, string>): RoomsIndex => {
  // Every other branch is a room. Branches of ringi 0.1 (`<room>/control`, `<room>/log/<agent>`) are not read.
  const names = roomNames(H, fetched)
  const byGenesis = new Map<string, Room>(), byTarget = new Map<string, Room>()
  for (const name of names) {
    const ref = 'refs/heads/' + name
    try {
      if (!P.ID_RE.test(name)) C.fail('invalid room name')
      const sha = fetched.get(TRACK + name) ?? C.fail(`${name} was deleted on the remote`)
      const data = branchData(H, name, sha)
      if (byGenesis.has(data.genesis)) C.fail('room genesis is already bound to another room')
      promote(H, ref, sha)
      // Local commits not yet published stay on top.
      const local = branchData(H, name, rev(H, ref)!, data.genesis)
      const R = {name, ref, head: local.control.at(-1)!, genesis: data.genesis}
      byGenesis.set(data.genesis, R)
      for (const target of [...local.control, ...local.authors.keys(), ...local.skipped.keys()]) byTarget.set(target, R)
    } catch (e) {H.remoteAlarms![ref] = reason(e)}
  }
  return {byGenesis, byTarget}
}

const roomNames = (H: Handle, fetched: Map<string, string>): Set<string> => {
  const names = new Set([...fetched.keys(), ...refs(H, ACCEPT).keys()].map(r => r.slice(r.startsWith(TRACK) ? TRACK.length : ACCEPT.length)).filter(r => r !== 'main' && !r.includes('/')))
  return names
}
