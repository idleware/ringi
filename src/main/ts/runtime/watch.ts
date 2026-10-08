// watch: headless turns for one agent of one room (core-1 §7). It holds that agent's seat, answers heartbeats in
// code, and spends only within a grant (decisions-1) or its own run budget. Usage receipts are written here, by the
// runner, never by the model.

import {spawn} from 'node:child_process'
import * as D from '../domain/decisions.ts'
import {HOME, OPERATOR, config, locked} from '../home/index.ts'
import {HIDDEN, append, openHub, openRoom, pongText} from '../hub/index.ts'
import {loadRoomUnlocked, loadState, readerLock, saveState} from './reader.ts'
import type {Room} from '../hub/index.ts'
import {isOpen, taskFor, taskOf} from '../domain/profiles.ts'
import {compose, link, unread, wakes} from '../protocol/index.ts'
import type {Message} from '../protocol/index.ts'
import {dropSession, liveness, parseSelector, pidAlive, readSession, saveSession, seatHolder, whoAmI} from './session.ts'
import {fail, note, short, sleep, stamp} from '../lib/index.ts'

// One turn: the command runs in a process group of its own (POSIX). At the deadline, or when the command itself
// ends, whatever is left of the group is asked to stop and, after a grace, killed; the turn ends when the group is
// empty, so no descendant outlives the run it was counted as.
const GRACE = 5000
type Ended = {code: number | null, signal: string | null, timedOut: boolean, seconds: number}
const groupAlive = (pid: number) => {
  try {
    process.kill(-pid, 0)
    return true
  } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}
const signalGroup = (pid: number, sig: NodeJS.Signals) => {
  try { process.kill(-pid, sig) } catch {}
}
const turn = (cmd: string, seconds: number | null, env: NodeJS.ProcessEnv): Promise<Ended> => new Promise(resolve => {
  const t0 = Date.now()
  const child = spawn('sh', ['-c', cmd], {stdio: 'inherit', env, detached: true})
  const pid = child.pid!
  let timedOut = false
  let exit: {code: number | null, signal: string | null} | null = null
  const end = async () => {
    signalGroup(pid, 'SIGTERM')
    const until = Date.now() + GRACE
    while (groupAlive(pid) && Date.now() < until) await sleep(50)
    if (groupAlive(pid)) signalGroup(pid, 'SIGKILL')
    while (groupAlive(pid)) await sleep(50)
    resolve({code: exit?.code ?? null, signal: exit?.signal ?? null, timedOut, seconds: Math.round((Date.now() - t0) / 1000)})
  }
  // At the deadline: SIGTERM to the group, and SIGKILL after the grace even if the shell ignores it.
  let hard: NodeJS.Timeout | undefined
  const timer = seconds ? setTimeout(() => {
    timedOut = true
    signalGroup(pid, 'SIGTERM')
    hard = setTimeout(() => signalGroup(pid, 'SIGKILL'), GRACE)
  }, seconds * 1000) : undefined
  const stopAll = () => signalGroup(pid, 'SIGTERM')
  process.once('SIGINT', stopAll)
  process.once('SIGTERM', stopAll)
  child.on('exit', (code, signal) => {
    exit = {code, signal}
    clearTimeout(timer)
    clearTimeout(hard)
    process.removeListener('SIGINT', stopAll)
    process.removeListener('SIGTERM', stopAll)
    void end()
  })
})

type Group = {grant: string | null, msgs: Message[], task: Message | null}
type Run = Group & {run?: string, timeout: number | null}
type Reserve = {why?: string, lost?: boolean, wait?: boolean, exhausted?: boolean, gr?: D.Grant, run?: string}

// What a watcher is told: whose seat (`<room>/<agent>` or `<hub>:<room>/<agent>`), the command of a headless turn, and
// its limits. `log` receives the watcher's own lines.
export type WatchOptions = {seat: string, exec: string, hub?: string, scope?: string, handoff?: boolean, once?: boolean, requireGrant?: boolean,
  interval?: number, from?: string[], maxHop?: number, maxRuns?: number, window?: number}
export const watch = async (w: WatchOptions, log: (line: string) => void = note): Promise<number> => {
  for (const [name, value] of [['interval', w.interval], ['window', w.window]] as const)
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) fail(`watch ${name} must be positive seconds`)
  for (const [name, value] of [['max-runs', w.maxRuns], ['max-hop', w.maxHop]] as const)
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) fail(`watch ${name} must be a nonnegative integer`)
  const sel = parseSelector(w.seat)
  const cmd = w.exec
  const H0 = openHub(sel.hub ?? w.hub ?? config().hub)
  const R0 = openRoom(H0, sel.room)!
  const me = sel.agent
  if (R0.archived) fail(`${R0.name} is archived`)
  if (!R0.members[me]) fail(`${me} is not a member of ${R0.name}; the operator adds it with a join, or watch another agent`)
  // Each watcher process is its own session, so two of them can never share one seat record.
  const raw = `watch-${H0.name}-${R0.genesis.slice(0, 8)}-${me}-${process.pid}`
  const handle = `env:${raw}`
  locked('sessions', () => {
    const holder = seatHolder(H0.name, R0.genesis, me, handle)
    const handoff = w.handoff && holder?.product !== 'watch' && holder?.handle === whoAmI().handle
    if (w.handoff && !handoff) fail('watch --handoff needs the invoking chat to own this seat')
    if (handoff && holder!.state === 'stopped') fail('this chat is stopped; continue it before a handoff')
    if (holder && !handoff && (holder.product !== 'watch' || (holder.pid && pidAlive(holder.pid)))) fail(`${R0.name}/${me} is held by session ${holder.handle} (${liveness(holder)}); one seat per agent. Its chat may use watch --handoff`)
    if (holder) dropSession(holder.handle)
    saveSession({handle, product: 'watch', hub: H0.name, room: R0.name, genesis: R0.genesis, agent: me, scope: w.scope ?? holder?.scope ?? null,
      state: holder?.state === 'stopped' ? 'stopped' : 'active', since: stamp(), lastSeen: stamp(), pid: process.pid,
      takenFrom: handoff ? holder!.handle : holder?.takenFrom})
  })
  const interval = (w.interval ?? 5) * 1000
  const allow = w.from ? new Set(w.from) : null
  const maxHop = w.maxHop ?? 8
  const maxRuns = w.maxRuns ?? 10
  const span = w.window ?? 86400
  let runSeq = 0
  for (;;) {
    const s = locked('sessions', () => {
      const cur = readSession(handle)
      if (cur?.state === 'active') saveSession({...cur, lastSeen: stamp(), pid: process.pid})
      return cur
    })
    if (!s) { log(`watch: the seat of ${me} was released or taken over; stopping`); return 0 }
    if (s.state === 'stopped') {
      if (w.once) { log('watch: stopped by the operator'); return 0 }
      await sleep(interval)
      continue
    }
    const H = openHub(H0.name, {refresh: true})
    const R = openRoom(H, R0.name, {quiet: true})
    if (!R || R.genesis !== R0.genesis || !R.members[me]) { log(`watch: ${R0.name} is gone, recreated or archived, or ${me} was removed; stopping`); return 0 }
    const P = R.profile
    // Lock order throughout planning and dispatch: grant, reader, sessions (then the store's own writes).
    const plan = locked(`grant-${H.name}`, () => readerLock(R, me, () => {
      const {logs, st} = loadRoomUnlocked(R, me)
      if (st.inflight) {
        st.seen = st.inflight.seen
        st.inflight = undefined
        saveState(R, me, st)
      }
      const all = link(logs)
      // Heartbeats: one pong per allowed ping, in code; a separate durable cursor, never a model run.
      const heartbeatSeen = {...st.heartbeatSeen}
      const answered = new Set((logs.get(me) ?? []).filter(m => m.kind === 'pong').map(m => m.reId))
      for (const [id, msgs] of logs) {
        if (id === me) continue
        const at = msgs.findIndex(m => m.id === heartbeatSeen[id])
        for (const m of msgs.slice(at + 1)) {
          if (m.bad || m.kind !== 'ping' || !m.to.includes(me) || answered.has(m.id) || m.hopEff >= maxHop || (allow && !allow.has(m.from))) continue
          append(R, me, pongText(me, m, 'has a watcher'))
          note(`watch: answered heartbeat ${short(m.id)} from ${m.from}`)
        }
        if (msgs.length) heartbeatSeen[id] = msgs.at(-1)!.id
      }
      const {msgs: fresh, cursors} = unread(logs, me, st.watched ?? st.seen ?? {}, Infinity, HIDDEN)
      const retry = (st.pending ?? []).flatMap(id => {
        const m = all.get(id)
        if (!m) return []
        const task = taskFor(all, m, P)
        return !task || isOpen(taskOf(all, task, P), P) ? [m] : []
      })
      const msgs = [...new Map([...retry, ...fresh].map(m => [m.id, m])).values()]
      const go = msgs.filter(m => wakes(m, me, HIDDEN) && m.hopEff < maxHop && (!allow || allow.has(m.from)))
      for (const m of msgs) if (!go.includes(m)) note(`watch: not waking for ${short(m.id)} from ${m.from} (to ${m.to.join(',')}, hop ${m.hopEff})`)
      // Group by the grant of each message's work; a message outside a grant spends the watcher's own budget.
      const groups = new Map<string | null, Group>()
      for (const m of go) {
        const task = taskFor(all, m, P)
        const g = task ? taskOf(all, task, P).grant : null
        if (!groups.has(g)) groups.set(g, {grant: g, msgs: [], task})
        groups.get(g)!.msgs.push(m)
      }
      const runs: Run[] = []
      let hold = false
      const now = Date.now() / 1000
      let ownRuns = (st.runs ?? []).filter(t => t > now - span)
      const exhausted = {...st.exhausted}
      for (const grp of groups.values()) {
        if (!grp.grant) {
          if (w.requireGrant) {
            for (const m of grp.msgs) note(`watch: ${short(m.id)} is outside any grant; --require-grant: not starting a turn`)
            continue
          }
          if (ownRuns.length >= maxRuns) {
            hold = true
            note(`watch: own run budget spent (${maxRuns} per ${span}s); ${grp.msgs.length} message(s) wait`)
            continue
          }
          ownRuns = [...ownRuns, now]
          runs.push({...grp, timeout: null})
          continue
        }
        // The grant lock covers reservation and decisions on this machine.
        const r: Reserve = (() => {
          // Fence: only the watcher that holds the seat reserves.
          if (readSession(handle)?.pid !== process.pid) return {why: 'this watcher no longer holds the seat', lost: true}
          const gr = D.grantOf(all, R.authorityAt, grp.grant)
          if (!gr) return {why: `grant ${short(grp.grant)} is not an approved decision with a budget`}
          if (gr.revoked) return {why: `grant ${short(gr.id)} was revoked`, exhausted: true, gr}
          const u = D.usageOf(all, gr)
          if (u.left <= 0) return {why: `grant ${short(gr.id)} is spent: ${u.runs}/${gr.budget.runs} runs`, exhausted: true, gr}
          if (u.open >= gr.budget.concurrency) return {why: `grant ${short(gr.id)} has ${u.open} run(s) open, concurrency ${gr.budget.concurrency}`, wait: true}
          const run = `${raw}.${process.pid}.${Date.now().toString(36)}.${runSeq++}`
          append(R, me, compose(`usage: reserve a run of ${me}`, [['To', OPERATOR], ['Kind', 'usage'], ['Grant', gr.id], ['Usage', 'reserve'], ['Run', run]]))
          return {gr, run}
        })()
        if (r.lost) return {runs: [] as Run[], hold: true, lost: true}
        if (r.wait) {
          hold = true
          note(`watch: ${r.why}; waiting`)
          continue
        }
        if (r.why) {
          note(`watch: ${r.why}`)
          const key = `${grp.task?.id}/${grp.grant}`
          if (r.exhausted && grp.task && !exhausted[key]) {
            exhausted[key] = true
            const t = taskOf(all, grp.task, P)
            const last = grp.msgs.at(-1)!
            // The profile names its waiting state, if it has one; otherwise the answer carries no state.
            if (isOpen(t, P)) append(R, me, compose(`${r.why}; waiting for a new grant`, [['To', [...new Set([t.requester, OPERATOR])].join(', ')], ['Re', last.id], ['State', P.waiting], ['Hop', String(last.hopEff + 1)]]))
          }
          continue
        }
        runs.push({...grp, run: r.run, timeout: r.gr!.budget['run-seconds']})
      }
      const pending = [...new Set([...retry.map(m => m.id), ...runs.flatMap(r => r.msgs.map(m => m.id))])]
      saveState(R, me, {...loadState(R, me), heartbeatSeen, exhausted, pending, runs: ownRuns,
        ...(hold ? {} : {watched: cursors})})
      return {runs, hold, lost: false}
    }))
    if (plan.lost) { log(`watch: the seat of ${me} was taken over; stopping`); return 0 }
    let exitCode = 0
    const settle = (run: Run, seconds: number, exit: number, why?: string) => append(R, me, compose(`usage: settle a run of ${me}${why ? ` (${why})` : ''}`,
      [['To', OPERATOR], ['Kind', 'usage'], ['Grant', run.grant], ['Usage', 'settle'], ['Run', run.run], ['Seconds', String(seconds)], ['Exit', String(exit)]]))
    for (const run of plan.runs) {
      // Spawn under the same locks as revocation and stop; wait for the turn after releasing them.
      const next: {why?: string, done?: Promise<Ended>} = locked(`grant-${H.name}`, () => {
        if (run.grant) {
          const {logs} = readerLock(R, me, () => loadRoomUnlocked(R, me))
          const gr = D.grantOf(link(logs), R.authorityAt, run.grant)
          if (!gr || gr.revoked) return {why: !gr ? 'its grant is no longer valid' : 'its grant was revoked'}
        }
        readerLock(R, me, () => {
          const st = loadState(R, me)
          saveState(R, me, {...st, inflight: {seen: st.seen ?? {}}})
        })
        return locked('sessions', () => {
          const cur = readSession(handle)
          if (!cur || cur.pid !== process.pid) return {why: 'the seat was taken over'}
          if (cur.state !== 'active') return {why: 'the watcher was stopped'}
          note(`watch: ${run.msgs.length} new${run.grant ? ` under grant ${short(run.grant)}` : ''}: ${cmd}`)
          return {done: turn(cmd, run.timeout, {...process.env, RINGI_HOME: HOME, RINGI_SESSION: raw, RINGI_MSGS: run.msgs.map(m => m.id).join('\n'), RINGI_GRANT: run.grant ?? ''})}
        })
      })
      if (next.why) {
        note(`watch: not starting the next turn: ${next.why}`)
        if (run.run) settle(run, 0, 125, `not started: ${next.why}`)
        continue
      }
      const r = await next.done!
      note(`watch: exit ${r.code ?? r.signal}${r.timedOut ? ' (stopped at the grant\'s run-seconds)' : ''} after ${r.seconds}s`)
      // Settled only once the whole turn, descendants included, has ended.
      if (run.run) settle(run, r.seconds, r.code ?? 128)
      readerLock(R, me, () => {
        const st = loadState(R, me), delivered = new Set(run.msgs.map(m => m.id))
        // A deadline is an intentional budget stop, not a delivery failure to spend another run on.
        const deliveredTurn = r.code === 0 || r.timedOut
        saveState(R, me, {...st, inflight: undefined, ...(deliveredTurn
          ? {pending: (st.pending ?? []).filter(id => !delivered.has(id))}
          : {seen: st.inflight?.seen ?? st.seen})})
      })
      if (r.code !== 0 || r.timedOut) exitCode ||= r.code || 128
    }
    if (w.once) return exitCode || (plan.hold ? 4 : 0)
    await sleep(interval)
  }
}
export type {Room}
