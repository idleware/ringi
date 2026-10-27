// Advertise once and fetch only named protocol refs. Stale staging refs never prove current remote presence.
import {fail} from '../../../lib/index.ts'
import {networkGit, rev, tracking} from './git.ts'
import type {Handle} from './types.ts'
import {SHA} from './types.ts'

export const fetchSelected = (H: Handle, url: string, names: string[]): Map<string, string> => {
  const fetched = new Map<string, string>(), wanted = new Set(names)
  const advertised = [...new Set(networkGit(H, ['ls-remote', '--heads', '--refs', url]).trim().split('\n')
    .filter(Boolean).map(line => line.split('\t')).filter(([sha, ref]) => SHA.test(sha) && wanted.has(ref)).map(([, ref]) => ref))]
  if (!advertised.length) return fetched
  // Explicit refspecs via stdin avoid the command-line size limit without a wildcard or extra connections.
  networkGit(H, ['-c', 'fetch.fsckObjects=true', 'fetch', '-q', '--stdin', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', url],
    {input: advertised.map(ref => `+${ref}:${tracking(ref)}`).join('\n') + '\n'})
  for (const ref of advertised) {
    const track = tracking(ref), head = rev(H, track) ?? fail('selected remote ref disappeared during fetch')
    fetched.set(track, head)
  }
  // Required refs may still carry arbitrarily large histories. This selects refs; it is not a received-pack quota.
  return fetched
}
