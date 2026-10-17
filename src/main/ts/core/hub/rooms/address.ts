// Public room addresses have one parser and canonical serializer; transport locators stay separate.
import {ID_RE} from '../protocol/model.ts'
import {bad, controls, roomName, component, encoded, localPath} from './address-codec.ts'
import {authority, hostName, servicePort} from './address-host.ts'

// E8 parser seam, not yet called: a public room address is distinct from the Git locator below.
export type RoomProvider = 'github' | 'gitlab' | 'forgejo' | 'gitea'
export type RemoteSpace = {kind: 'space', provider: RoomProvider, host: string, port?: number, space: string}
export type RoomAddress =
  | {kind: 'local', room: string}
  | {kind: 'path', path: string}
  | {kind: 'remote', provider: RoomProvider, host: string, port?: number, space: string, room: string}
export type RoomSelector = RoomAddress | {kind: 'name', room: string}
export interface RoomAddressParser {
  // Bare create is local; a missing remote room is a space, for a durable create reservation to fill.
  (input: string, operation: 'create'): RoomAddress | RemoteSpace
  // Bare lookup is a catalogue selector; it never chooses a space or allocates a room.
  (input: string, operation: 'lookup'): RoomSelector
}
export type CanonicalAddress = (address: RoomAddress | RemoteSpace, serviceDefault?: number) => string

const providers: Record<string, RoomProvider> = {github: 'github', gh: 'github', gitlab: 'gitlab', gl: 'gitlab', forgejo: 'forgejo', gitea: 'gitea'}
const remoteAddress = (provider: RoomProvider, host: string, raw: string, operation: 'create' | 'lookup'): RoomAddress | RemoteSpace => {
  const parts = raw.startsWith('/') ? raw.slice(1).split('/').map(component) : []
  if (parts.length < 1 || parts.length > 2 || parts.some(p => !ID_RE.test(p)) || parts.at(-1)!.endsWith('.git')) return bad('remote address needs one space and an optional room, without a .git suffix')
  const base = {provider, ...authority(host), space: parts[0]}
  if (parts.length === 2) return {kind: 'remote', ...base, room: roomName(parts[1])}
  return operation === 'create' ? {kind: 'space', ...base} : bad('an existing room needs a full address')
}
const localAddress = (host: string, raw: string, operation: 'create' | 'lookup'): RoomAddress => {
  if (host) return raw ? bad('local alias must have no path') : {kind: 'local', room: roomName(component(host))}
  const parts = localPath(raw).map(component)
  if (operation === 'create') roomName(parts.at(-1)!)
  return {kind: 'path', path: '/' + parts.join('/')}
}
// Raw structure is checked before any URL normalization. No filesystem or provider is consulted here.
export const parseAddress: RoomAddressParser = ((input: string, operation: 'create' | 'lookup'): RoomSelector | RemoteSpace => {
  if (typeof input !== 'string' || !input || /[\s\\?#@]/u.test(input) || controls.test(input)) return bad('whitespace, control, userinfo or query/fragment')
  if (operation !== 'create' && operation !== 'lookup') return bad('unknown address operation')
  if (!input.includes('://')) {
    const room = roomName(component(input))
    return operation === 'create' ? {kind: 'local', room} : {kind: 'name', room}
  }
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/]*)(.*)$/i.exec(input)
  if (!match) return bad('invalid scheme or structure')
  const scheme = match[1].toLowerCase()
  if (scheme === 'local') return localAddress(match[2], match[3], operation)
  const provider = Object.hasOwn(providers, scheme) ? providers[scheme] : bad('unsupported provider scheme')
  return remoteAddress(provider, match[2], match[3], operation)
}) as RoomAddressParser

const remoteCanonical = (address: Extract<RoomAddress, {kind: 'remote'}> | RemoteSpace, serviceDefault?: number): string => {
  if (!Object.values(providers).includes(address.provider) || !ID_RE.test(address.space)) return bad('invalid provider or space')
  const host = hostName(address.host)
  if (address.space.endsWith('.git')) return bad('remote address must not have a .git suffix')
  const base = address.provider + '://' + host + servicePort(address.port, serviceDefault) + '/' + encoded(address.space)
  if (address.kind === 'space') return base
  const room = roomName(address.room)
  return room.endsWith('.git') ? bad('remote address must not have a .git suffix') : base + '/' + encoded(room)
}
// Without a selected adapter's explicit service default, an explicit port is retained.
export const canonical: CanonicalAddress = (address, serviceDefault) => {
  switch (address.kind) {
    case 'local': return 'local://' + encoded(roomName(address.room))
    case 'path': return 'local:///' + localPath(address.path).map(encoded).join('/')
    case 'space': case 'remote': return remoteCanonical(address, serviceDefault)
    default: return bad('unknown address kind')
  }
}

export {storeOf, transportOf} from './store-address.ts'
