// Transport acknowledgements and reader pins retain evidence. They do not define any reader's semantic frontier.
import {fail} from '../../../lib/index.ts'
import {ancestor, refs, rev} from './git.ts'
import type {Handle, Room} from './types.ts'

export const streamEvidence = (H: Handle, R: Room): Map<string, string[]> => {
  const result = new Map<string, string[]>()
  if (H.layout !== 'git/4') return result
  const reader = `refs/ringi/accepted/${R.genesis}/`
  for (const [ref] of [...refs(H, reader), ...refs(H, 'refs/ringi/remote-accepted/')]) {
    const name = ref.startsWith(reader) ? /^[^/]+\/signals\/([^/]+)$/.exec(ref.slice(reader.length)) : /^refs\/ringi\/remote-accepted\/([^/]+)\/signals$/.exec(ref)
    if (!name) continue
    const sha = rev(H, ref) ?? fail('accepted signal evidence no longer names a commit')
    result.set(name[1], [...result.get(name[1]) ?? [], sha])
  }
  return result
}
export const missingStreamEvidence = (H: Handle, pins: string[], head: string): string | undefined =>
  pins.find(pin => !ancestor(H, pin, head))
