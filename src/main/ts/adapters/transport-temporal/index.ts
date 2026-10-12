// temporal: a planned store type. It is registered so that a hub naming it is refused with a clear reason; it becomes
// real by implementing the Store port and its Transport (core/hub/ports/store.ts) here.
import type {Transport} from '../../core/hub/ports/store.ts'
import {fail} from '../../lib/index.ts'

const planned = (d: {name: string}): never => fail(`hub ${d.name}: the temporal store is planned and not implemented in this ringi`)
export const temporal: Transport = {layout: 'temporal/1', open: (_at, d) => planned(d), create: (_at, d) => planned(d)}
