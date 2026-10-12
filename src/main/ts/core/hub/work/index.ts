// profile: what a task is, as data. ringi is a point of coordination, not a methodology: the states of a piece of
// work, which of them end it, and who may move it, assign it or label people in it are declared by a profile
// that lives in the hub (`profiles/<name>.json` on main) and is chosen per room. The A2A task model is one such
// profile (resources/profiles/a2a-1.json); a team or a framework brings its own (architect, reviewer, tester, …).
// This file interprets any profile; it knows no state, role or rule by name.

import type {Message} from '../protocol/index.ts'

export const PROFILE_SCHEMA = 'ringi-profile/1'
export const DEFAULT_PROFILE = 'a2a-1'
// A hub whose rooms may follow profiles other than the built-in A2A rules declares this capability, so that an older
// client, which knows only those rules, refuses it instead of misreading it.
export const PROFILES_CAPABILITY = 'profiles/1'

// A rule lists principals: `requester` (who opened the work), `assignee`, `member` (anyone in the room),
// `role:<label>` (whoever holds that label in the work), or `agent:<id>`. An empty or missing rule allows nobody;
// an exact `state:<s>` rule replaces `state:*` for that state.
// `grant` is retired: a profile may still name it, and nothing acts on it.
export type Rules = {assign?: string[], roles?: string[], grant?: string[], [state: `state:${string}`]: string[] | undefined}
export type Profile = {
  schema: typeof PROFILE_SCHEMA
  name: string
  description?: string
  opens: string
  states: string[]
  initial: string
  terminal: string[]
  // The state of work that cannot go on without input; none if the profile has no such state.
  waiting?: string
  rules: Rules
}
export type Task = {
  root: Message
  msgs: Message[]
  state: string
  by: string
  at: number
  requester: string
  assignees: string[]
  roles: Record<string, string>
  // What each message actually changed, in fold order: `opened`, `assigned`, `roles`, `state.<s>`. A trailer
  // the author had no right to is not here; signals (core/hub/signals) are made only from these.
  effects: Map<string, string[]>
}

export * from './parse.ts'
export * from './task.ts'
