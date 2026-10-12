// host-posix: macOS/Linux process facts and launch control behind ProcessHost (core/agents/ports/host.ts). Its handles belong
// only to this instance. A bounded observation never grants authority to stop an otherwise running process.

import {fail} from '../../lib/fail.ts'
import {treeCpu} from './stats.ts'
import type {Clock, Ended, ProcessHandle, ProcessHost} from '../../core/agents/ports/host.ts'
import {launch} from './launch.ts'
import {alive, ancestors, snapshot, supported} from './probes.ts'

const systemClock: Clock = {wall: () => Date.now(), monotonic: () => performance.now()}
const observe = (done: Promise<Ended>, deadline: number | undefined, clock: Clock): Promise<Ended | null> => {
  if (deadline !== undefined && !Number.isFinite(deadline)) fail('a process observation deadline must be finite')
  const held = setInterval(() => {}, 1000)
  if (deadline === undefined) return done.finally(() => clearInterval(held))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { clearInterval(held); resolve(null) }, Math.max(0, deadline - clock.monotonic()))
    const clear = () => { clearTimeout(timer); clearInterval(held) }
    done.then(value => { clear(); resolve(value) }, error => { clear(); reject(error) })
  })
}
export const hostPosix = (clock: Clock = systemClock): ProcessHost => {
  const processes = new WeakMap<ProcessHandle, ReturnType<typeof launch>>()
  const own = (handle: ProcessHandle) => processes.get(handle) ?? fail('this process handle belongs to another host')
  return {
    supported, clock, alive, ancestors, snapshot,
    inspect: (pid, rows = snapshot()) => ({alive: supported ? alive(pid) : null, cpu: treeCpu(pid, rows)}),
    start: request => {
      const handle = {} as ProcessHandle
      processes.set(handle, launch(request, clock))
      return handle
    },
    stop: handle => own(handle).stop(),
    awaitQuiescence: (handle, deadline) => observe(own(handle).done, deadline, clock),
  }
}
