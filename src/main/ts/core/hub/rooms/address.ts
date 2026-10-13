// A storage address names its implementation explicitly; adapters receive only the locator they understand.
import {fail} from '../../../lib/index.ts'
import {hubPorts} from '../ports/index.ts'
import type {Transport} from '../ports/store.ts'

export const storeOf = (address: string): {type: string, locator: string} => {
  const m = typeof address === 'string' && !/[\r\n\0]/.test(address)
    && /^([a-z][a-z0-9.-]*)(?:\+([a-z][a-z0-9.-]*))?:\/\/(.+)$/i.exec(address)
  if (!m) return fail('a room address must name its store scheme, such as git+ssh://, git+https:// or git+file://')
  const type = m[1].toLowerCase()
  if (['ssh', 'http', 'https', 'file'].includes(type)) fail('address has no explicit store type; use git+ssh://, git+https:// or git+file://')
  return {type, locator: m[2] ? `${m[2].toLowerCase()}://${m[3]}` : address}
}

export const transportOf = (name: string, type: string): Transport => {
  const {transports, build} = hubPorts()
  return transports[type] ?? fail(`hub ${name} uses a ${type} store; this ringi ${build.version} knows ${Object.keys(transports).join(', ')}`)
}
