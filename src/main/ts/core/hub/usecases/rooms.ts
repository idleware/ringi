// rooms: the rooms this machine knows, each by its address (docs/spec/hub-2.md, Room addresses): list, switch, delete,
// and accept a new baseline for a log after reviewing an alarm; making one is room-create.ts. A bare name selects the
// one known room of it.

import {hubPorts} from '../ports/index.ts'
import type {RoomFiles} from '../ports/location.ts'
import type {TransportV4} from '../ports/store.ts'
import {config, deleteRoomRegistration, hubNames, isRegisteredRoom, openHub, openRegisteredRoom, setConfig} from '../rooms/index.ts'
import type {DeletedRegistration, Hub, Room, RoomV2} from '../rooms/index.ts'
import {canonical, parseAddress} from '../rooms/address.ts'
import {registeredTransportOf} from '../rooms/store-address.ts'
import {registrationContext, roomCatalogue} from '../rooms/room-catalogue.ts'
import type {RoomRegistration} from '../rooms/room-catalogue.ts'
import {Fail, fail, note} from '../../../lib/index.ts'

export {forgetLog} from './roster.ts'

const files = (): RoomFiles => hubPorts().roomFiles ?? fail('this ringi has no room locations wired')
export const catalogue = (): ReturnType<typeof roomCatalogue> => roomCatalogue(hubPorts().state)
export const transportOfHub = (H: Hub): TransportV4 => registeredTransportOf(H.name, H.d.store.type)
export const active = (r: RoomRegistration): r is RoomRegistration & {phase: 'active'} => r.phase === 'active' && !r.endpoint.disposal
// The registration an address or a bare name selects: the one this machine knows, else none.
const registration = (selector: string): RoomRegistration & {phase: 'active'} => {
  const r = catalogue().select(parseAddress(selector, 'lookup'), files())
  return active(r) ? r : fail(`room ${r.address} is not ready: its creation or deletion did not finish`)
}
// The full context of the room an address or name selects, read from this machine's catalogue alone.
export const contextOf = (selector: string): readonly string[] => registrationContext(registration(selector))
// How a room is named to people: its address; a room of the older layout, which has none, by its name.
export const addressOf = (R: Room): string => isRegisteredRoom(R) ? R.endpoint.address : R.name
// A room by its address or name; without one, the terminal's current room.
export const roomNamed = (selector?: string | null): RoomV2 => {
  hubPorts().state.ensure()
  const r = registration(selector ?? config().room ?? fail('no current room: ringi room create [<address>] | ringi room switch <address>'))
  const H = openHub(r.owner.name)
  return openRegisteredRoom(H, r.address, transportOfHub(H))
}
// A room the catalogue knows but that does not open is told, not listed; an alarm stays one.
const opens = (r: RoomRegistration & {phase: 'active'}): RoomV2 | null => {
  try { return roomNamed(r.address) } catch (e) {
    if (!(e instanceof Fail)) throw e
    note(e.message.startsWith('ALARM') ? e.message : `room ${r.address}: ${e.message}`)
    return null
  }
}
export type RoomView = {address: string, name: string, context: readonly string[], current: boolean, members: number, profile: string, genesis: string, signed: boolean}
export const rooms = (): RoomView[] => {
  hubPorts().state.ensure()
  const cur = config().room
  return catalogue().all().filter(active).flatMap(r => {
    const R = opens(r)
    return R ? [{address: r.address, name: R.name, context: R.context, current: r.address === cur, members: Object.keys(R.members).length, profile: R.profile.name, genesis: R.genesis, signed: R.hub.signed}] : []
  })
}

export const use = (selector: string): RoomV2 => {
  const R = roomNamed(selector)
  setConfig({room: R.endpoint.address})
  return R
}
// The room a delete names, by address or name, also one whose deletion stopped half way and no longer opens.
export type Doomed = RoomRegistration & {phase: 'active'}
export const doomed = (selector?: string | null): Doomed => {
  hubPorts().state.ensure()
  const sel = selector ?? config().room ?? fail('no current room: ringi room delete <address> --yes')
  const parsed = parseAddress(sel, 'lookup'), all = catalogue().all().filter((r): r is Doomed => r.phase === 'active')
  const found = parsed.kind === 'name' ? all.filter(r => r.name === parsed.room) : all.filter(r => r.address === canonical(parsed) || r.aliases.includes(canonical(parsed)))
  if (found.length > 1) fail(`ambiguous room; use one full address: ${found.map(r => r.address).join(', ')}`)
  return found[0] ?? fail(`no room ${sel} on this machine`)
}
// A room's repository on this machine moved aside and its records archived, for good: one in the home's directories is
// ringi's to move; one at a path of the operator's (local:///…) is only forgotten, its files left where they are.
// Nothing is erased. Sessions bound to it, here or elsewhere, leave it on their own (core/agents/sessions).
export const erase = (r: Doomed): DeletedRegistration => {
  const mode = parseAddress(r.address, 'lookup').kind === 'path' ? 'unregister' : 'managed'
  const done = deleteRoomRegistration(r, {confirmed: true, mode})
  if (config().room === r.address) setConfig({room: null})
  return done
}
// The hubs this machine keeps rooms of: `local`, and one per space.
export const hubOfRoom = (selector?: string | null): Hub => selector || config().room ? roomNamed(selector).hub
  : hubNames().includes('local') ? openHub('local') : fail('no current room: ringi hub amend --room <address>')
