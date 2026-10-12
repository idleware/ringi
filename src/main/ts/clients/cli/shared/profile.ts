// profile: `profile` (what work is in the room) and `who` (its members).

import * as Room from '../../../core/hub/usecases/room.ts'
import type {Opts} from '../args.ts'
import {dump, flag, out} from '../args.ts'
import type {Ctx} from '../context.ts'

export const profileCmd = ({R}: Ctx, o: Opts) => {
  if (flag(o, 'json')) return dump(R.profile)
  const P = R.profile
  out(`room ${R.name} follows profile ${P.name}${P.description ? `: ${P.description}` : ''}`)
  out(`opens with Kind: ${P.opens}; states: ${P.states.join(', ')}; initial ${P.initial}; terminal ${P.terminal.join(', ')}${P.waiting ? `; waiting ${P.waiting}` : ''}`)
  for (const [k, v] of Object.entries(P.rules)) out(`  ${k.padEnd(18)} ${(v ?? []).join(', ')}`)
}

export const who = (a: Ctx) => {
  for (const x of Room.members(a)) out(`${x.id.padEnd(12)} ${x.role.padEnd(7)} ${String(x.messages).padStart(4)} msg`)
}
