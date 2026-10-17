// A single strict UTF-8 decode and canonical component encoding, shared by the public-address grammar.
import {fail} from '../../../lib/index.ts'
import {ID_RE} from '../protocol/model.ts'

export const controls = /[\u0000-\u001f\u007f-\u009f]/
export const bad = (why: string): never => fail('bad room address: ' + why)
export const roomName = (name: string): string =>
  ID_RE.test(name) && name !== 'main' && name !== 'chat' ? name : bad('invalid or reserved room name')
const emptyOrDot = (value: string): boolean => ['', '.', '..'].includes(value)
const invalidText = (value: string): boolean => /[/\\]/.test(value) || controls.test(value)
const invalidComponent = (value: string): boolean =>
  emptyOrDot(value) || invalidText(value) || Buffer.from(value, 'utf8').toString('utf8') !== value
export const component = (raw: string): string => {
  if (!raw || /[:@!$&'()*+,;=\[\]]/.test(raw)) return bad('empty component or unencoded reserved character')
  let decoded: string
  try { decoded = decodeURIComponent(raw) } catch { return bad('invalid percent escape or UTF-8') }
  if (invalidComponent(decoded)) return bad('invalid path component')
  return decoded
}
export const encoded = (value: string): string => {
  try { return encodeURIComponent(value).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase()) }
  catch { return bad('invalid Unicode component') }
}
export const localPath = (value: string): string[] => {
  if (!value.startsWith('/') || value === '/') return bad('local path must be absolute and non-root')
  const parts = value.slice(1).split('/')
  if (parts.some(invalidComponent)) return bad('invalid local path')
  return parts
}
export const portNumber = (raw: string): number => {
  if (!/^[0-9]+$/.test(raw)) return bad('invalid service port')
  const port = Number(raw)
  return Number.isSafeInteger(port) && port >= 1 && port <= 65535 ? port : bad('service port must be 1 to 65535')
}
