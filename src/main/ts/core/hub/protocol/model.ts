// model: what the protocol is made of — ids, trailers, messages — with no behaviour (docs/spec/core-1.md).

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
