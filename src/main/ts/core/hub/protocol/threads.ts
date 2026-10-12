// threads: Re links and effective hops, and reading a thread (core-1 §5); the order of messages is order.ts.

import {fail} from '../../../lib/index.ts'
import type {All, Logs, Message} from './model.ts'
import {ordered} from './order.ts'

// The hop a message counts from its parent: one more than an answered message, one for an unresolved Re.
const hopAfter = (m: Message, eff: Map<string, number>): number => m.reId ? eff.get(m.reId)! + 1 : m.re ? 1 : 0
// Effective hops along a message's Re chain, from the nearest one already known.
const settleHops = (all: All, eff: Map<string, number>, m: Message): void => {
  const chain: Message[] = []
  for (let x: Message | undefined = m; x && !eff.has(x.id) && chain.length < 100000; x = x.reId ? all.get(x.reId) : undefined) chain.push(x)
  for (const c of chain.reverse()) eff.set(c.id, Math.max(c.hop, hopAfter(c, eff)))
}
// Resolves Re and computes effective hops. Invalid messages are absent: a Re naming one does not resolve.
export const link = (logs: Logs): All => {
  const all: All = new Map()
  for (const msgs of logs.values()) for (const m of msgs) if (!m.invalid) all.set(m.id, m)
  for (const m of all.values()) m.reId = m.re && all.has(m.re) ? m.re : null
  const eff = new Map<string, number>()
  for (const m of all.values()) {
    settleHops(all, eff, m)
    m.hopEff = eff.get(m.id)!
  }
  return all
}

const chainHas = (all: All, m: Message, top: Message): boolean => {
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
