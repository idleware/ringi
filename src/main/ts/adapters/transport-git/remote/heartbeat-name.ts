import * as C from '../../../lib/index.ts'
import {SHA, TAGS} from './types.ts'

// Heartbeats deliberately share the tag transport, but never the immutable signal acceptance.
// Only this exact namespace is mutable; e.g. `actor.opened.heartbeat.<id>` is still a signal.
export const HEARTBEAT_NAME = /^([a-z0-9]+(?:[_-][a-z0-9]+)*)\.heartbeat\.([0-9a-f]{12})$/

export const heartbeatName = (ref: string): {actor: string, genesis12: string} | null => {
  const m = ref.startsWith(TAGS) && HEARTBEAT_NAME.exec(ref.slice(TAGS.length))
  return m ? {actor: m[1], genesis12: m[2]} : null
}

export const heartbeatRef = (who: string, genesis: string): string => {
  if (!SHA.test(genesis)) C.fail('heartbeat requires a full room genesis')
  const ref = `${TAGS}${who}.heartbeat.${genesis.slice(0, 12)}`
  if (!heartbeatName(ref)) C.fail('malformed heartbeat actor')
  return ref
}
