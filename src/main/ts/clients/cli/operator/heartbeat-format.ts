// heartbeat-format: one line per heartbeat, as this machine judges it or as the room publishes it.

import type {Pulse} from '../../../core/agents/heartbeat/pulse.ts'
import {short} from '../../../lib/index.ts'

type Published = ReturnType<typeof import('../../../core/agents/heartbeat/pulse.ts').published>[number]
export const publishedLine = (h: Published) => `${h.agent.padEnd(12)} ${(h.waits ? `${h.state} (${h.waits})` : h.state).padEnd(22)} ${h.age}s ago${h.overdue ? ', overdue' : ''}  on ${short(h.target)}`
export const pulseLine = ({session: s, tool, beat: b}: Pulse) => {
  const state = b.waits ? `${b.state} (${b.waits})` : b.state
  return `${s.agent.padEnd(12)} ${`${s.hub}/${s.room}`.padEnd(24)} ${state.padEnd(22)} alive ${b.alive === null ? '?' : b.alive ? 'yes' : 'no'}  quiet ${b.quiet}s${b.cpu === null ? '' : `  cpu ${b.cpu.toFixed(1)}s`}  ${tool}  ${s.handle}`
}
