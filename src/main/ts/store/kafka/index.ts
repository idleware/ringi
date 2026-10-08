// kafka: a planned store type. It is registered so that a hub naming it is refused with a clear reason; it becomes
// real by implementing the Store port (store/index.ts) here.
import type {StoreFactory} from '../index.ts'
import {fail} from '../../lib/index.ts'

export const kafka: StoreFactory = (_dir, d) => fail(`hub ${d.name}: the kafka store is planned and not implemented in this ringi`)
