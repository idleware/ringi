// A typed transport locator is separate from a public room address; the adapter registry selects its store.
import {fail} from '../../../lib/index.ts'
import {hubPorts} from '../ports/index.ts'
import type {RoomTransport, Transport, TransportV4} from '../ports/store.ts'

export const storeOf = (address: string): {type: string, locator: string} => {
  const m = typeof address === 'string' && !/[\r\n\0]/.test(address)
    && /^([a-z][a-z0-9.-]*)(?:\+([a-z][a-z0-9.-]*))?:\/\/(.+)$/i.exec(address)
  if (!m) return fail('a room address must name its store scheme, such as git+ssh://, git+https:// or git+file://')
  const type = m[1].toLowerCase()
  if (['ssh', 'http', 'https', 'file'].includes(type)) fail('address has no explicit store type; use git+ssh://, git+https:// or git+file://')
  return {type, locator: m[2] ? `${m[2].toLowerCase()}://${m[3]}` : address}
}

export const transportOf = (name: string, type: string): RoomTransport => {
  const {transports, build} = hubPorts()
  return transports[type] ?? fail(`hub ${name} uses a ${type} store; this ringi ${build.version} knows ${Object.keys(transports).join(', ')}`)
}

export const isRegisteredTransport = (t: RoomTransport): t is TransportV4 => {
  if (t.layout !== 'git/4') return false
  if (!('checkLocation' in t) || typeof t.checkLocation !== 'function' || !('recoverPrepared' in t) || typeof t.recoverPrepared !== 'function') {
    return fail('git/4 transport must provide its location and recovery checks')
  }
  return true
}
export const registeredTransportOf = (name: string, type: string): TransportV4 => {
  const t = transportOf(name, type)
  return isRegisteredTransport(t) ? t : fail(`hub ${name}: registered rooms require explicit git/4 transport`)
}
export const legacyTransportOf = (name: string, type: string): Transport => {
  const t = transportOf(name, type)
  if (isRegisteredTransport(t)) return fail('endpoint/1 operations cannot use git/4 transport; open the registered room')
  return t
}
