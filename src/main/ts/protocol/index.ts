// protocol: the message protocol, docs/spec/core-1.md (§3, §5–§7), independent of storage and of any task model. A store
// turns its records into messages and hands them here: text, threads, inboxes and waking live in this file. What a
// task is, which states it has and who may move it, is a profile (profile.ts), not part of the protocol.

import {CC_RE} from './files.ts'
import {fail} from '../lib/index.ts'

export const ID_RE = /^(?=.{1,64}$)[a-z0-9]+(?:[._-][a-z0-9]+)*(?<!\.lock)$/
// An agent's id has no dot: it starts the name of its signals, `<agent>.<signal>.<message12>`.
export const AGENT_RE = /^(?=.{1,64}$)[a-z0-9]+(?:[_-][a-z0-9]+)*$/
export const TOKEN_RE = /^[a-z][a-z0-9-]*$/
export const HOP_RE = /^(?:0|[1-9]\d{0,5})$/
export const TRAILER_RE = /^([A-Za-z][A-Za-z0-9-]*):[ \t]*(.*)$/
export const TEXT_MAX = 64 * 1024
// Trailers the protocol itself interprets; any other trailer belongs to an extension or a profile.
export const KNOWN = new Set(['to', 're', 'kind', 'state', 'hop', 'assign', 'roles'])
export const HEARTBEATS = new Set(['ping', 'pong'])
// Kinds that are bookkeeping, never delivered to an inbox: heartbeats, usage receipts, cards, room records.
export const HIDDEN = new Set(['ping', 'pong', 'usage', 'card', 'room'])

export type Trailers = Record<string, string[]>
export type FileRef = {path: string, size: number | null}
export type Refused = {path: string, mode?: string, why?: string}
export type Message = {
  id: string
  from: string
  trust: 'asserted' | 'verified'
  time: number
  seq: number
  // Text is absent (invalid) or parsed; a malformed message keeps its text but routes nowhere (`bad`).
  invalid: string | null
  subject: string
  body: string
  to: string[]
  re: string | null
  kind: string | null
  state: string | null
  assign: string[] | null
  // Free labels: `<id>=<label>`. The protocol gives no label a meaning; a profile may.
  roles: Record<string, string> | null
  hop: number
  bad: string | null
  trailers: Trailers
  files: FileRef[]
  refused: Refused[]
  // Set by link(): the resolved Re and the effective hop count.
  reId: string | null
  hopEff: number
}
export type Logs = Map<string, Message[]>
export type All = Map<string, Message>
export type Parsed = Pick<Message, 'subject' | 'body' | 'to' | 're' | 'kind' | 'state' | 'assign' | 'roles' | 'hop' | 'bad' | 'trailers'>
export const one = (m: {trailers: Trailers}, k: string): string | null => m.trailers[k]?.[0] ?? null

// --- text (§3) ---

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
// Parses well-formed and malformed text alike; `bad` names why a message routes nowhere. `isRef` is the store's
// grammar for message ids in `Re`.
export const parse = (raw: string, isRef: (s: string) => boolean): Parsed => {
  const text = raw.replace(/\r\n/g, '\n').trimEnd()
  const cut = text.lastIndexOf('\n\n')
  const tail = cut < 0 ? [] : text.slice(cut + 2).split('\n')
  const has = tail.length > 0 && tail.every(l => TRAILER_RE.test(l))
  const trailers: Trailers = {}
  if (has) {
    for (const l of tail) {
      const [, k, v] = TRAILER_RE.exec(l)!
      const key = k.toLowerCase()
      trailers[key] = [...(trailers[key] ?? []), v.trim()]
    }
  }
  const head = has ? text.slice(0, cut) : text
  const nl = head.indexOf('\n')
  const subject = (nl < 0 ? head : head.slice(0, nl)).trim()
  const bad = [...KNOWN].filter(k => (trailers[k]?.length ?? 0) > 1).map(k => `duplicate ${k}`)
  const get = (k: string) => trailers[k]?.[0] ?? null
  const ids = (v: string | null) => v === null ? null : [...new Set(v.split(',').map(x => x.trim()))]
  const to = get('to') === '*' ? ['*'] : ids(get('to'))
  const assign = ids(get('assign'))
  // Roles: `<id>=<label>, …`; the label `none` clears one.
  const pairs = get('roles') === null ? null : get('roles')!.split(',').map(x => x.trim().split('=').map(y => y.trim()))
  if (pairs && !pairs.every(p => p.length === 2 && ID_RE.test(p[0]) && TOKEN_RE.test(p[1]))) bad.push('malformed Roles')
  if (!subject) bad.push('empty subject')
  if (Buffer.byteLength(raw) > TEXT_MAX) bad.push('text over 64 KiB')
  if (!has) bad.push('no trailer block')
  else if (!to) bad.push('no To')
  else if (to[0] !== '*' && !to.every(x => ID_RE.test(x))) bad.push('malformed To')
  if (assign && !assign.every(x => ID_RE.test(x))) bad.push('malformed Assign')
  if (get('re') !== null && !isRef(get('re')!)) bad.push('malformed Re')
  if (get('hop') !== null && !HOP_RE.test(get('hop')!)) bad.push('malformed Hop')
  // A state is a token; whether the room's profile knows it is the store's check.
  if (get('state') !== null && !TOKEN_RE.test(get('state')!)) bad.push('malformed State')
  if (get('kind') !== null && !TOKEN_RE.test(get('kind')!)) bad.push('malformed Kind')
  const ok = !bad.length
  return {
    subject,
    body: nl < 0 ? '' : head.slice(nl + 1).replace(/^\n+/, '').trimEnd(),
    // A malformed message is read as if it had no trailers.
    to: ok ? to! : [],
    assign: ok ? assign : null,
    roles: ok && pairs ? Object.fromEntries(pairs) : null,
    re: ok ? get('re') : null,
    kind: ok ? get('kind') : null,
    state: ok ? get('state') : null,
    hop: ok && get('hop') !== null ? Number(get('hop')) : 0,
    bad: bad.join(', ') || null,
    trailers,
  }
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

// --- threads (§5) ---

// Resolves Re and computes effective hops. Invalid messages are absent: a Re naming one does not resolve.
export const link = (logs: Logs): All => {
  const all: All = new Map()
  for (const msgs of logs.values()) for (const m of msgs) if (!m.invalid) all.set(m.id, m)
  for (const m of all.values()) m.reId = m.re && all.has(m.re) ? m.re : null
  const eff = new Map<string, number>()
  for (const m of all.values()) {
    const chain: Message[] = []
    for (let x: Message | undefined = m; x && !eff.has(x.id) && chain.length < 100000; x = x.reId ? all.get(x.reId) : undefined) chain.push(x)
    for (let i = chain.length - 1; i >= 0; i--) {
      const c = chain[i]
      eff.set(c.id, Math.max(c.hop, c.reId ? eff.get(c.reId)! + 1 : c.re ? 1 : 0))
    }
    m.hopEff = eff.get(m.id)!
  }
  return all
}
// Kahn's order: the answered message before the answer, earlier before later within one log; among the ready ones,
// the smallest (time, id) goes first.
export const ordered = (list: Message[]): Message[] => {
  const byId = new Map(list.map(m => [m.id, m]))
  const next = new Map<string, Message[]>(list.map(m => [m.id, []]))
  const indeg = new Map<string, number>(list.map(m => [m.id, 0]))
  const edge = (a: Message, b: Message) => {
    next.get(a.id)!.push(b)
    indeg.set(b.id, indeg.get(b.id)! + 1)
  }
  const last = new Map<string, Message>()
  for (const m of [...list].sort((a, b) => a.seq - b.seq)) {
    if (last.has(m.from)) edge(last.get(m.from)!, m)
    last.set(m.from, m)
    if (m.reId && byId.has(m.reId)) edge(byId.get(m.reId)!, m)
  }
  const ready = list.filter(m => !indeg.get(m.id))
  const res: Message[] = []
  while (ready.length) {
    ready.sort((a, b) => a.time - b.time || (a.id < b.id ? -1 : 1))
    const m = ready.shift()!
    res.push(m)
    for (const n of next.get(m.id)!) {
      indeg.set(n.id, indeg.get(n.id)! - 1)
      if (!indeg.get(n.id)) ready.push(n)
    }
  }
  return res
}
export const chainHas = (all: All, m: Message, top: Message): boolean => {
  for (let x: Message | undefined = m, i = 0; x && i < 10000; x = x.reId ? all.get(x.reId) : undefined, i++) if (x === top) return true
  return false
}
export const rootOf = (all: All, m: Message): Message => {
  let x = m
  for (let i = 0; x.reId && all.has(x.reId) && i < 10000; i++) x = all.get(x.reId)!
  return x
}
export const under = (all: All, top: Message): Message[] => ordered([...all.values()].filter(m => chainHas(all, m, top)))
export const lookup = (all: All, ref: string): Message => {
  const key = String(ref ?? '').toLowerCase()
  if (all.has(key)) return all.get(key)!
  const hits = key.length >= 4 ? [...all.keys()].filter(k => k.startsWith(key)) : []
  if (hits.length === 1) return all.get(hits[0])!
  return fail(hits.length ? `ambiguous message id ${ref}` : `unknown message ${ref}`)
}

// --- reading (§6) and waking (§7) ---

// Delivered: well-formed, not a hidden kind, addressed to `id` by name or `*`.
export const visible = (m: Message, id: string, hidden: Set<string>): boolean =>
  !m.invalid && !m.bad && !(m.kind && hidden.has(m.kind)) && (m.to.includes(id) || m.to.includes('*'))
// Wakes: only a direct address. Broadcasts are read when the agent is awake for another reason.
export const wakes = (m: Message, id: string, hidden: Set<string>): boolean => visible(m, id, hidden) && m.to.includes(id)
// Messages for `id` after the per-log cursors; cursors advance only past what was shown.
export const unread = (logs: Logs, id: string, cursors: Record<string, string>, limit = Infinity, hidden: Set<string>) => {
  const fresh: Message[] = []
  for (const [log, msgs] of logs) {
    if (log === id) continue
    const at = msgs.findIndex(m => m.id === cursors[log])
    fresh.push(...msgs.slice(at + 1).filter(m => visible(m, id, hidden)))
  }
  const queue = ordered(fresh)
  const shown = queue.slice(0, limit)
  const seen = new Set(shown.map(m => m.id))
  const next = {...cursors}
  for (const [log, msgs] of logs) {
    if (log === id) continue
    const at = msgs.findIndex(m => m.id === cursors[log])
    for (const m of msgs.slice(at + 1)) {
      if (visible(m, id, hidden) && !seen.has(m.id)) break
      next[log] = m.id
    }
  }
  return {msgs: shown, rest: queue.length - shown.length, cursors: next}
}
