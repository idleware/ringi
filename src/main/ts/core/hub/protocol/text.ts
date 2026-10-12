// text: a message's text (core-1 §3) — decoding, the trailer block, and why a message is malformed.

import {fail} from '../../../lib/index.ts'
import {CC_RE} from './files.ts'
import {HOP_RE, ID_RE, KNOWN, TEXT_MAX, TOKEN_RE, TRAILER_RE} from './model.ts'
import type {Parsed, Trailers} from './model.ts'

const utf8 = new TextDecoder('utf-8', {fatal: true})
// Invalid text is dangerous bytes: readers treat the message as absent.
export const decodeText = (buf: Uint8Array): {text: string, invalid?: undefined} | {invalid: string, text?: undefined} => {
  let s: string
  try { s = utf8.decode(buf) } catch { return {invalid: 'not valid UTF-8'} }
  s = s.replace(/\r\n/g, '\n')
  if (/\r/.test(s)) return {invalid: 'a CR not followed by LF'}
  if (CC_RE.test(s)) return {invalid: 'control characters in the text'}
  return {text: s}
}

// The trailer block: the last paragraph, when every line of it is a trailer.
const trailerBlock = (text: string): {head: string, trailers: Trailers, has: boolean} => {
  const cut = text.lastIndexOf('\n\n')
  const tail = cut < 0 ? [] : text.slice(cut + 2).split('\n')
  const has = tail.length > 0 && tail.every(l => TRAILER_RE.test(l))
  const trailers: Trailers = {}
  for (const l of has ? tail : []) {
    const [, k, v] = TRAILER_RE.exec(l)!
    const key = k.toLowerCase()
    trailers[key] = [...(trailers[key] ?? []), v.trim()]
  }
  return {head: has ? text.slice(0, cut) : text, trailers, has}
}
const ids = (v: string | null): string[] | null => v === null ? null : [...new Set(v.split(',').map(x => x.trim()))]
// Roles: `<id>=<label>, …`; the label `none` clears one.
const rolePairs = (v: string | null): string[][] | null => v === null ? null : v.split(',').map(x => x.trim().split('=').map(y => y.trim()))
const isRole = (p: string[]): boolean => p.length === 2 && ID_RE.test(p[0]) && TOKEN_RE.test(p[1])
const allIds = (xs: string[] | null): boolean => !xs || xs.every(x => ID_RE.test(x))
// A trailer present but outside its grammar.
const malformed = (v: string | null, ok: (v: string) => boolean): boolean => v !== null && !ok(v)
// Why the address makes a message route nowhere, if it does.
const addressProblem = (has: boolean, to: string[] | null): string | null => {
  if (!has) return 'no trailer block'
  if (!to) return 'no To'
  return to[0] === '*' || allIds(to) ? null : 'malformed To'
}

type Fields = {get: (k: string) => string | null, to: string[] | null, assign: string[] | null, pairs: string[][] | null}
type Shape = {raw: string, subject: string, has: boolean, trailers: Trailers}
// Why the message is malformed, each reason once, in a fixed order.
const problems = ({raw, subject, has, trailers}: Shape, f: Fields, isRef: (s: string) => boolean): string[] => {
  const address = addressProblem(has, f.to)
  const found: Array<[boolean, string]> = [
    [!!f.pairs && !f.pairs.every(isRole), 'malformed Roles'],
    [!subject, 'empty subject'],
    [Buffer.byteLength(raw) > TEXT_MAX, 'text over 64 KiB'],
    [address !== null, address ?? ''],
    [!allIds(f.assign), 'malformed Assign'],
    [malformed(f.get('re'), isRef), 'malformed Re'],
    [malformed(f.get('hop'), v => HOP_RE.test(v)), 'malformed Hop'],
    // A state is a token; whether the room's profile knows it is the store's check.
    [malformed(f.get('state'), v => TOKEN_RE.test(v)), 'malformed State'],
    [malformed(f.get('kind'), v => TOKEN_RE.test(v)), 'malformed Kind'],
  ]
  const duplicates = [...KNOWN].filter(k => (trailers[k]?.length ?? 0) > 1).map(k => `duplicate ${k}`)
  return [...duplicates, ...found.filter(([b]) => b).map(([, why]) => why)]
}
// A malformed message is read as if it had no trailers.
const UNROUTED = {to: [], assign: null, roles: null, re: null, kind: null, state: null, hop: 0}
const routed = ({get, to, assign, pairs}: Fields) => ({to: to!, assign, roles: pairs ? Object.fromEntries(pairs) : null,
  re: get('re'), kind: get('kind'), state: get('state'), hop: get('hop') === null ? 0 : Number(get('hop'))})

// Parses well-formed and malformed text alike; `bad` names why a message routes nowhere. `isRef` is the store's
// grammar for message ids in `Re`.
export const parse = (raw: string, isRef: (s: string) => boolean): Parsed => {
  const {head, trailers, has} = trailerBlock(raw.replace(/\r\n/g, '\n').trimEnd())
  const nl = head.indexOf('\n')
  const subject = (nl < 0 ? head : head.slice(0, nl)).trim()
  const get = (k: string): string | null => trailers[k]?.[0] ?? null
  const f: Fields = {get, to: get('to') === '*' ? ['*'] : ids(get('to')), assign: ids(get('assign')), pairs: rolePairs(get('roles'))}
  const bad = problems({raw, subject, has, trailers}, f, isRef)
  const body = nl < 0 ? '' : head.slice(nl + 1).replace(/^\n+/, '').trimEnd()
  return {subject, body, trailers, bad: bad.join(', ') || null, ...(bad.length ? UNROUTED : routed(f))}
}
export const compose = (text: string, trailers: Array<[string, string | null | undefined | false]>): string =>
  `${text}\n\n${trailers.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n')}\n`
// A client refuses to write what readers would drop or ignore (§3).
export const checkOutgoing = (text: string, isRef: (s: string) => boolean): Parsed => {
  const d = decodeText(Buffer.from(text))
  if (d.invalid !== undefined) fail(`refusing to send: ${d.invalid}`)
  const m = parse(d.text!, isRef)
  if (m.bad) fail(`refusing to send a malformed message: ${m.bad}`)
  return m
}
