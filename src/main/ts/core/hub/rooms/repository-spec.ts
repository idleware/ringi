// Provisioning resolves transport choice explicitly; the requested signing identity and original intent stay intact.
import {fail} from '../../../lib/index.ts'
import {storeOf} from './store-address.ts'
import {provisionRemote} from './provision-remote.ts'

export type RoomCreationSpec = {
  contract: string
  files: Record<string, string>
  description?: string
  quorum?: number
  reach?: {remote?: string, keyRef?: string, authRef?: string, hostKeys?: string[]}
}
// Only the unresolved requested spec is consumed. TransportAuth still refuses an explicitly bound non-SSH endpoint.
export const provisionedRepository = (requested: RoomCreationSpec, value: string): RoomCreationSpec => {
  const remote = provisionRemote(value)
  const {remote: prior, authRef, hostKeys, ...identity} = requested.reach ?? {}
  if (prior !== undefined) return fail('provisioned repository requires an unresolved requested locator')
  const ssh = new URL(storeOf(remote).locator).protocol === 'ssh:'
  return {...requested, reach: {...identity, remote,
    ...(ssh && authRef ? {authRef} : {}), ...(ssh && hostKeys ? {hostKeys: [...hostKeys]} : {}),
  }}
}
