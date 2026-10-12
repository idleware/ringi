// platform: the public compatibility facade for process probes. All I/O belongs to the selected ProcessHost;
// sample parsing stays pure. The legacy SUPPORTED constant describes the original bundled platforms.

import {agentPorts} from '../../core/agents/ports/index.ts'
import type {ProcessRows} from '../../core/agents/ports/host.ts'
export {procStat, seconds} from './stats.ts'

export const SUPPORTED = process.platform === 'darwin' || process.platform === 'linux'
export const alive = (pid: number): boolean => agentPorts().host.alive(pid)
export const table = (): ProcessRows | null => agentPorts().host.snapshot()
export const treeCpu = (pid: number, rows = table()): number | null => agentPorts().host.inspect(pid, rows).cpu
