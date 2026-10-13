// context: who runs a command and in which room, from the command line.

import * as Context from '../../core/hub/usecases/context.ts'
import {opt} from './args.ts'
import type {Opts} from './args.ts'

export type {Ctx} from '../../core/agents/sessions/context.ts'
export {isRef} from '../../core/hub/usecases/room.ts'
export const operatorCtx = (o: Opts) => Context.operator({room: opt(o, 'room')})
