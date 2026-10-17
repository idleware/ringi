// ports (hub): what the hub needs from the world it runs in — this build, the machine's state, the store types — and
// where an implementation plugs in. Code asks `hubPorts()` and never imports an adapter; composition/ wires them in
// when a program starts. The agents' own ports are apart (core/agents/ports).

import {fail} from '../../../lib/fail.ts'
import type {LocalState} from './state.ts'
import type {RoomTransport} from './store.ts'
import type {AccessType} from './access.ts'
import type {RoomFiles} from './location.ts'

export type {Key, LocalState} from './state.ts'
export type {RoomFiles} from './location.ts'

// What this build is: its version, and where its resources (profiles, the skill) are.
export type Build = {version: string, resources: string}
// The store types by name (hub.json names one), in the order they are listed; a new hub gets `store`. The access types
// by name, for hubs whose rooms a medium keeps.
export type HubPorts = {build: Build, state: LocalState, transports: Record<string, RoomTransport>, store: string, access?: Record<string, AccessType>, roomFiles?: RoomFiles}

let wired: HubPorts | null = null
export const wireHub = (p: HubPorts): void => { wired = p }
export const hubPorts = (): HubPorts => wired ?? fail('ringi is not wired: a program starts it through composition/')
// Exclusive across the processes of this machine (LocalState.locked).
export const locked = <T>(name: string, fn: () => T): T => hubPorts().state.locked(name, fn)
