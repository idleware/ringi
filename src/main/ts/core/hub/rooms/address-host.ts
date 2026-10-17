// Public-address service authorities: ASCII DNS, explicit IP literals and numeric ports; no resolution or discovery.
import {isIP} from 'node:net'
import {domainToASCII, domainToUnicode} from 'node:url'
import {bad, controls, portNumber} from './address-codec.ts'

const ipv6 = (raw: string): string => {
  if (!raw.endsWith(']') || isIP(raw.slice(1, -1)) !== 6) return bad('invalid IPv6 host')
  return new URL('http://' + raw + '/').hostname
}
const dnsLabel = (label: string): boolean => {
  if (label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) return false
  if (!label.startsWith('xn--')) return true
  const decoded = domainToUnicode(label)
  // Some runtimes return an invalid ACE label unchanged; that is not a successful Unicode decode.
  return /[^\x00-\x7f]/.test(decoded) && !controls.test(decoded) && domainToASCII(decoded) === label
}
const dnsName = (raw: string): string => {
  if (/^[0-9.]+$/.test(raw)) return bad('IPv4 must use four decimal octets')
  const host = raw.toLowerCase()
  const labels = host.split('.')
  if (host.length > 253 || labels.some(label => !dnsLabel(label))
    || domainToASCII(host) !== host) return bad('invalid ASCII DNS host')
  return host
}
export const hostName = (raw: string): string => {
  if (!raw || /[^\x21-\x7e]|[%@\\]/.test(raw)) return bad('invalid service host')
  if (raw.startsWith('[')) return ipv6(raw)
  return isIP(raw) === 4 ? raw : dnsName(raw)
}
export const authority = (raw: string): {host: string, port?: number} => {
  const match = /^(\[[^\]]+\]|[^:]+)(?::([0-9]+))?$/.exec(raw)
  if (!match) return bad('invalid authority')
  return {host: hostName(match[1]), ...(match[2] !== undefined ? {port: portNumber(match[2])} : {})}
}
export const servicePort = (shown?: number, serviceDefault?: number): string => {
  const value = shown === undefined ? undefined : portNumber(String(shown))
  const declared = serviceDefault === undefined ? undefined : portNumber(String(serviceDefault))
  return value === undefined || value === declared ? '' : ':' + value
}
