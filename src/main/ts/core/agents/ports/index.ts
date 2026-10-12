// ports (agents): what running agents on this machine needs from it — the agent tools it knows — and where an
// implementation plugs in. Code asks `agentPorts()`; composition/ wires them in when a program starts.

import {fail} from '../../../lib/fail.ts'
import type {AgentTool} from './tools.ts'
import type {ProcessHost} from './host.ts'

export type {AgentTool, Env, SessionRef} from './tools.ts'

export type AgentPorts = {tools: readonly AgentTool[], host: ProcessHost}

let wired: AgentPorts | null = null
export const wireAgents = (p: AgentPorts): void => { wired = p }
export const agentPorts = (): AgentPorts => wired ?? fail('ringi is not wired: a program starts it through composition/')
