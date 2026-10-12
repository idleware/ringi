// context: who runs a command and in which room, from the command line.

import * as Context from '../../core/hub/usecases/context.ts'
import {words} from '../../lib/index.ts'
import {opt} from './args.ts'
import type {Opts} from './args.ts'

export type {Ctx} from '../../core/agents/sessions/context.ts'
export {isRef} from '../../core/hub/usecases/room.ts'
export const parseTo = (v: unknown) => [...new Set(words(v))]
export const operatorCtx = (o: Opts) => Context.operator({hub: opt(o, 'hub'), room: opt(o, 'room')})
