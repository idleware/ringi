// watch-process: compatibility for the watcher turn API. The chosen ProcessHost owns the isolated launch, deadline
// and group settlement; a receipt is never written before that host reports its result.

import {fail} from '../../lib/fail.ts'
import {agentPorts} from '../../core/agents/ports/index.ts'
import type {Ended, Environment} from '../../core/agents/ports/host.ts'
export type {Ended} from '../../core/agents/ports/host.ts'

export const turn = async (cmd: string, seconds: number | null, env: Environment): Promise<Ended> => {
  const host = agentPorts().host
  return await host.awaitQuiescence(host.start({shell: cmd, timeout: seconds, env}))
    ?? fail('the process host did not settle the turn')
}

