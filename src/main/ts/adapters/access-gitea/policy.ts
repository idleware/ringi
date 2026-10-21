// The account matrix, after the API's raw rule shapes have been checked.
import {fail} from '../../lib/index.ts'
import type {Grants} from '../../core/hub/ports/access.ts'
import {actorOf, listed, pushers} from './rule-shape.ts'
import type {Rule, Tag} from './rule-shape.ts'

export const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
export const ordered = (rows: Rule[]) => {
  const fallback = rows.find(r => r.rule_name === '**')
  if (!fallback) return
  if (fallback.enable_push || listed(fallback).length) fail('Gitea fallback must deny all pushes')
  if (rows.some(r => r !== fallback && r.priority >= fallback.priority)) fail('Gitea exact branch rules must precede the deny fallback')
}
const rootBranch = (row: Rule | undefined, root: string) => {
  if (row && pushers(row).join() !== root) fail('Gitea main and operator/signals are the root\'s')
}
const signalsOn = (rows: Rule[], root: string): Grants['signals'] => {
  const signals: Grants['signals'] = {}
  for (const r of rows.filter(row => actorOf(row.rule_name) !== null)) {
    const users = pushers(r), actor = actorOf(r.rule_name)!
    if (users.length !== 1 || !users[0]) fail('Gitea each actor must have its own account')
    if (Object.values(signals).some(p => same(p, users[0]))) fail('Gitea each actor must have its own account')
    if (actor !== 'operator' && same(users[0], root)) fail('Gitea each actor must have its own account')
    signals[actor] = users[0]
  }
  return signals
}
const closedTags = (ts: Tag[], root: string) => {
  if (!ts.length) return
  if (ts.length !== 1 || ts[0].name_pattern !== '*') fail('Gitea tags are not closed to all but the root')
  if (ts[0].whitelist_teams?.length) fail('Gitea tags are not closed to all but the root')
  if (!['', root].includes((ts[0].whitelist_usernames ?? []).join())) fail('Gitea tags are not closed to all but the root')
}
export const policy = (rows: Rule[], ts: Tag[], root: string, complete: boolean): Grants => {
  const by = new Map(rows.map(r => [r.rule_name, r])), main = pushers(by.get('main')), chat = pushers(by.get('chat'))
  rootBranch(by.get('main'), root); rootBranch(by.get('operator/signals'), root)
  const signals = signalsOn(rows, root)
  closedTags(ts, root)
  const full = [by.has('**'), main.join() === root, chat.includes(root), signals.operator === root, ts.length > 0]
  if (complete && !full.every(Boolean)) fail('Gitea incomplete root, chat, signals, fallback or tag policy')
  return {main, chat, signals}
}
export const grantMapping = (now: Grants, actor: string, principal: string) => {
  if (Object.entries(now.signals).some(([a, p]) => a !== actor && same(p, principal))) fail(`${principal} already writes another actor's signals`)
  if (Object.hasOwn(now.signals, actor) && !same(now.signals[actor], principal)) fail(`${actor} writes through another account`)
}
export const revokeMapping = (rows: Rule[], actor: string, principal: string) => {
  if (rows.some(x => x.rule_name.endsWith('/signals') && x.rule_name !== `${actor}/signals` && listed(x).some(p => same(p, principal))))
    fail(`${principal} is named on another actor's signals; nothing is revoked`)
  if (listed(rows.find(x => x.rule_name === `${actor}/signals`)).some(p => !same(p, principal))) fail(`${actor} names another account; nothing is revoked`)
}
