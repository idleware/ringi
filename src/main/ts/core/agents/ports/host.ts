// host: process facts and isolated launches, apart from any operating system or agent tool. A launch is held by an
// opaque handle; only its host may stop it. A deadline uses the host's monotonic clock, dates its wall clock.

export type Environment = Record<string, string | undefined>
export type ProcessRows = Map<number, {ppid: number, cpu: number}>
export type Ancestor = {pid: number, name: string}
export type Ended = {code: number | null, signal: string | null, timedOut: boolean, seconds: number}
export type Clock = {wall(): number, monotonic(): number}
declare const handle: unique symbol
export type ProcessHandle = {readonly [handle]: true}
export type Launch = {env: Environment} & (
  {shell: string, timeout: number | null} | {file: string, args: readonly string[]}
)

export interface ProcessHost {
  readonly supported: boolean
  readonly clock: Clock
  alive(pid: number): boolean
  ancestors(pid: number): Ancestor[]
  snapshot(): ProcessRows | null
  inspect(pid: number, rows?: ProcessRows | null): {alive: boolean | null, cpu: number | null}
  start(request: Launch): ProcessHandle
  stop(process: ProcessHandle): void
  // null: the caller's observation deadline expired; it does not silently stop the process. Omitting it preserves
  // the existing watcher's wait for the entire group (including the known zombie-without-reaper limitation).
  awaitQuiescence(process: ProcessHandle, deadline?: number): Promise<Ended | null>
}
