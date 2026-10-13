// Invitation pins adopted as a catalogue, without a contract source or a membership grant.
import {hubPorts, locked} from '../ports/index.ts'
import {fail} from '../../../lib/index.ts'
import type {Descriptor, Rev} from '../ports/store.ts'
import {descriptorRefusal} from './compat.ts'
import {hubNames, openHub} from './hubs.ts'
import type {Hub} from './index.ts'
// An invitation supplies pins, never credentials or a default repository. Adoption grants no room membership.
const matchingHub = (d: Descriptor): Hub | null => {
  for (const existing of hubNames()) {
    const H = openHub(existing), known = H.d
    if (known.genesis !== d.genesis) continue
    if (known.trust !== d.trust || known.root !== d.root) fail('invitation changes the trust or root of an existing hub genesis')
    return H
  }
  return null
}
export const adoptHub = ({trust, root, genesis}: {trust: Descriptor['trust'], root?: string, genesis: Rev}): Hub => locked('hub-catalogue', () => {
  const st = hubPorts().state, name = genesis.slice(0, 12)
  const d: Descriptor = {schema: 'ringi-hub/3', name, trust, genesis, store: {type: hubPorts().store}, ...(root ? {root} : {})}
  const why = descriptorRefusal(d, name)
  if (why) fail(why)
  const known = matchingHub(d)
  if (known) return known
  if (st.list(['hub']).includes(name)) fail('hub genesis prefix conflicts with an existing catalogue name; nothing is replaced')
  st.write(['hub', name, 'hub'], d)
  return openHub(name)
})
