// config: the operator's terminal context on this machine: the hub and the room a command means when it names none.

import {hubPorts} from '../ports/index.ts'

export type Config = {hub: string, room: string | null}
export const config = (): Config => ({hub: 'local', room: null, ...hubPorts().state.read<Partial<Config>>(['config'], {})})
export const setConfig = (patch: Partial<Config>): void => hubPorts().state.write(['config'], {...config(), ...patch})
