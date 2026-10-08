// view: how messages, work, proposals and grants are shown: as text framed for people and models, and as the JSON
// shapes every interface (the CLI's --json, a control panel) returns.

import type {Budget, Proposal, Usage} from '../domain/decisions.ts'
import type {Task} from '../domain/profiles.ts'
import {bytes, when} from '../lib/index.ts'
import {KNOWN} from '../protocol/index.ts'
import type {All, FileRef, Message} from '../protocol/index.ts'

const id12 = (x: string) => x.slice(0, 12)
// Trailers a store writes about its own records (the git store's list of attached paths): shown as `Files:`, not again.
const STORED = new Set(['ringi-files'])
// Frames a message for a model: sender and how it is known, id, addressing, hop; the body is the peer's content.
export const render = (all: All, m: Message, {max = 0, files = () => m.files}: {max?: number, files?: () => FileRef[]} = {}): string => {
  const lines = [`=== ${id12(m.id)} · ${m.from} (${m.trust}) → ${m.to.join(', ') || '(nobody)'} · ${when(m.time)}`]
  if (m.re || m.trailers.re) {
    const p = m.reId ? all.get(m.reId) : undefined
    lines.push(`Re: ${id12(m.reId ?? m.re ?? m.trailers.re[0])}${p ? ` (${p.from}) ${p.subject}` : ' (not available)'}`)
  }
  if (m.bad) lines.push(`Malformed: ${m.bad} (not delivered, not part of tasks)`)
  if (m.kind) lines.push(`Kind: ${m.kind}`)
  if (m.state) lines.push(`State: ${m.state}`)
  if (m.assign) lines.push(`Assign: ${m.assign.join(', ')}`)
  if (m.roles) lines.push(`Roles: ${Object.entries(m.roles).map(([k, v]) => `${k}=${v}`).join(', ')}`)
  if (m.hopEff) lines.push(`Hop: ${m.hop}${m.hopEff !== m.hop ? ` (effective ${m.hopEff})` : ''}`)
  for (const [k, v] of Object.entries(m.trailers)) if (!KNOWN.has(k) && !STORED.has(k)) lines.push(`${k[0].toUpperCase()}${k.slice(1)}: ${v.join(', ')}`)
  const fl = files()
  if (fl.length) lines.push(`Files: ${fl.map(f => `${f.path} (${bytes(f.size ?? 0)})`).join(', ')}`)
  if (m.refused.length) lines.push(`Refused: ${m.refused.map(f => `${f.path} (${f.why ?? `mode ${f.mode}`})`).join(', ')}`)
  lines.push(`Subject: ${m.subject}`)
  const body = max && m.body.length > max ? `${m.body.slice(0, max)}\n[… ${m.body.length - max} more chars: read ${id12(m.id)}]` : m.body
  if (body) lines.push('', body)
  lines.push(`=== end ${id12(m.id)}`)
  return lines.join('\n')
}
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

