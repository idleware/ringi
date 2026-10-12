// singleton: one pulse for this machine, its process id kept in the state as `pulse`. Process facts and the detached
// launch belong to ProcessHost; a corrupt record never invents an owner.

import {agentPorts} from '../ports/index.ts'
import {hubPorts, locked} from '../../hub/ports/index.ts'

const PULSE = ['pulse']
const recorded = (): number => {
  let v: unknown
  try { v = hubPorts().state.read<unknown>(PULSE, 0) } catch { return 0 }
  return Number.isSafeInteger(v) && (v as number) > 0 ? v as number : 0
}
const running = (): number | null => {
  const pid = recorded()
  return pid && pid !== process.pid && agentPorts().host.alive(pid) ? pid : null
}
export const ensurePulse = (cli: string): void => {
  if (process.env.RINGI_PULSE === 'off' || running()) return
  agentPorts().host.start({file: process.execPath, args: [cli, 'pulse'], env: process.env})
}
export const claim = (): number | null => locked('pulse', () => {
  const pid = running()
  if (!pid) hubPorts().state.write(PULSE, process.pid)
  return pid
})
export const release = (): void => {
  try { if (recorded() === process.pid) hubPorts().state.remove(PULSE) } catch {}
}
