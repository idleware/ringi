// host-posix launch: an isolated shell turn settles its group before its result, as the watcher did before this
// adapter. Detached argv launches leave the caller's event loop. Only this module knows POSIX group signals.

import {spawn} from 'node:child_process'
import {sleep} from '../../lib/index.ts'
import type {Clock, Ended, Launch} from '../../core/agents/ports/host.ts'

const GRACE = 5000
type Running = {done: Promise<Ended>, stop(): void}
const groupAlive = (pid: number): boolean => {
  try { process.kill(-pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}
const signalGroup = (pid: number | undefined, sig: NodeJS.Signals): void => {
  if (pid) try { process.kill(-pid, sig) } catch {}
}
const detachedSettlement = async (pid: number | undefined): Promise<void> => {
  while (pid && groupAlive(pid)) await new Promise<void>(resolve => { setTimeout(resolve, 50).unref() })
}
const settle = async (pid: number | undefined): Promise<void> => {
  if (!pid) return
  signalGroup(pid, 'SIGTERM')
  const until = Date.now() + GRACE
  while (groupAlive(pid) && Date.now() < until) await sleep(50)
  if (groupAlive(pid)) signalGroup(pid, 'SIGKILL')
  while (groupAlive(pid)) await sleep(50)
}
const detached = (r: Extract<Launch, {file: string}>, clock: Clock): Running => {
  const at = clock.wall(), child = spawn(r.file, [...r.args], {stdio: 'ignore', env: r.env, detached: true})
  let finished = false
  const done = new Promise<Ended>((resolve, reject) => {
    child.once('error', e => { finished = true; reject(e) })
    child.once('exit', (code, signal) => {
      void detachedSettlement(child.pid).then(() => {
        finished = true
        resolve({code, signal, timedOut: false, seconds: Math.round((clock.wall() - at) / 1000)})
      }, reject)
    })
  })
  child.unref()
  // Fire-and-forget launches still handle spawn failures without an unhandled rejection.
  void done.catch(() => {})
  return {done, stop: () => { if (!finished) signalGroup(child.pid, 'SIGTERM') }}
}
const shell = (r: Extract<Launch, {shell: string}>, clock: Clock): Running => {
  const at = clock.wall(), child = spawn('sh', ['-c', r.shell], {stdio: 'inherit', env: r.env, detached: true})
  let timedOut = false, finished = false
  const stop = () => { if (!finished) signalGroup(child.pid, 'SIGTERM') }
  const done = new Promise<Ended>((resolve, reject) => {
    let hard: NodeJS.Timeout | undefined
    const timer = r.timeout ? setTimeout(() => {
      timedOut = true
      signalGroup(child.pid, 'SIGTERM')
      hard = setTimeout(() => signalGroup(child.pid, 'SIGKILL'), GRACE)
    }, r.timeout * 1000) : undefined
    const cleanup = () => {
      clearTimeout(timer); clearTimeout(hard)
      process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop)
    }
    process.once('SIGINT', stop); process.once('SIGTERM', stop)
    child.once('error', e => { finished = true; cleanup(); reject(e) })
    child.once('exit', (code, signal) => {
      cleanup()
      void settle(child.pid).then(() => {
        finished = true
        resolve({code, signal, timedOut, seconds: Math.round((clock.wall() - at) / 1000)})
      }, reject)
    })
  })
  return {done, stop}
}
export const launch = (request: Launch, clock: Clock): Running => 'shell' in request ? shell(request, clock) : detached(request, clock)
