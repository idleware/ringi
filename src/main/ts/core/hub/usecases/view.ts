// view: how messages, work, proposals and grants are shown: as text framed for people and models, and as the JSON
// shapes every interface (the CLI's --json, a control panel) returns.

import type {Budget, Proposal, Usage} from '../decisions/index.ts'
import type {Task} from '../work/index.ts'
import {bytes, when} from '../../../lib/index.ts'
import {KNOWN} from '../protocol/index.ts'
import type {All, FileRef, Message} from '../protocol/index.ts'

const id12 = (x: string) => x.slice(0, 12)
// Trailers a store writes about its own records (the git store's list of attached paths): shown as `Files:`, not again.
const STORED = new Set(['ringi-files'])
const reLines = (all: All, m: Message): string[] => {
  if (!m.re && !m.trailers.re) return []
  const p = m.reId ? all.get(m.reId) : undefined
  return [`Re: ${id12(m.reId ?? m.re ?? m.trailers.re[0])}${p ? ` (${p.from}) ${p.subject}` : ' (not available)'}`]
}
// What the message sets, in a fixed order, then the trailers ringi does not know, as written.
const trailerLines = (m: Message): string[] => {
  const known: Array<[string, string | null]> = [
    ['Malformed', m.bad ? `${m.bad} (not delivered, not part of tasks)` : null],
    ['Kind', m.kind || null], ['State', m.state || null], ['Assign', m.assign ? m.assign.join(', ') : null],
    ['Roles', m.roles ? Object.entries(m.roles).map(([k, v]) => `${k}=${v}`).join(', ') : null],
    ['Hop', m.hopEff ? `${m.hop}${m.hopEff !== m.hop ? ` (effective ${m.hopEff})` : ''}` : null],
  ]
  const other = Object.entries(m.trailers).filter(([k]) => !KNOWN.has(k) && !STORED.has(k))
    .map(([k, v]): [string, string] => [`${k[0].toUpperCase()}${k.slice(1)}`, v.join(', ')])
  return [...known, ...other].flatMap(([k, v]) => v === null ? [] : [`${k}: ${v}`])
}
const fileLines = (m: Message, fl: FileRef[]): string[] => [
  ...fl.length ? [`Files: ${fl.map(f => `${f.path} (${bytes(f.size ?? 0)})`).join(', ')}`] : [],
  ...m.refused.length ? [`Refused: ${m.refused.map(f => `${f.path} (${f.why ?? `mode ${f.mode}`})`).join(', ')}`] : [],
]
// The body, cut at `max` characters with a pointer to the whole.
const bodyLines = (m: Message, max: number): string[] => {
  const body = max && m.body.length > max ? `${m.body.slice(0, max)}\n[… ${m.body.length - max} more chars: read ${id12(m.id)}]` : m.body
  return body ? ['', body] : []
}
// Frames a message for a model: sender and how it is known, id, addressing, hop; the body is the peer's content.
export const render = (all: All, m: Message, {max = 0, files = () => m.files}: {max?: number, files?: () => FileRef[]} = {}): string => [
  `=== ${id12(m.id)} · ${m.from} (${m.trust}) → ${m.to.join(', ') || '(nobody)'} · ${when(m.time)}`,
  ...reLines(all, m), ...trailerLines(m), ...fileLines(m, files()),
  `Subject: ${m.subject}`, ...bodyLines(m, max),
  `=== end ${id12(m.id)}`,
].join('\n')
export const oneLine = (m: Message): string =>
  `${id12(m.id)}  ${when(m.time).slice(5)}  ${m.from} → ${m.to.join(',') || '-'}  ${[m.kind, m.state].filter(Boolean).map(x => `[${x}] `).join('')}${m.subject}`
export const asJson = (m: Message) => ({id: m.id, from: m.from, trust: m.trust, to: m.to, re: m.re, kind: m.kind, state: m.state,
  assign: m.assign, roles: m.roles, hop: m.hop, hopEff: m.hopEff, bad: m.bad, time: new Date(m.time * 1000).toISOString(), subject: m.subject,
  body: m.body, files: m.files.map(f => ({path: f.path, size: f.size})), refused: m.refused, trailers: m.trailers})

export type TaskView = {id: string, subject: string, requester: string, assignees: string[], roles: Record<string, string>,
  taken: string[], grant: string | null, state: string, by: string, at: string}
export const taskView = (t: Task, taken: string[]): TaskView => ({id: t.root.id, subject: t.root.subject, requester: t.requester,
  assignees: t.assignees, roles: t.roles, taken, grant: t.grant, state: t.state, by: t.by, at: new Date(t.at * 1000).toISOString()})
export type ProposalView = {id: string, subject: string, from: string, decider: string, state: string, budget: Budget | null,
  stamps: Proposal['stamps'], missing: string[]}
export const proposalView = (x: Proposal): ProposalView => ({id: x.proposal.id, subject: x.proposal.subject, from: x.proposal.from,
  decider: x.decider, state: x.state, budget: x.budget, stamps: x.stamps, missing: x.missing})
export type GrantView = {grant: string, proposal: string, subject: string, budget: Budget, revoked: boolean, usage: Usage}
export const grantView = (x: Proposal, usage: Usage): GrantView => ({grant: x.grant!.id, proposal: x.proposal.id,
  subject: x.proposal.subject, budget: x.grant!.budget, revoked: x.grant!.revoked, usage})

