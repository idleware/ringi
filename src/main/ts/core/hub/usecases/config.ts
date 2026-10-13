// config: the operator's terminal context on this machine: the room a command means when it names none.

import {hubPorts} from '../ports/index.ts'

export type Config = {room: string | null}
export const config = (): Config => ({room: null, ...hubPorts().state.read<Partial<Config>>(['config'], {})})
export const setConfig = (patch: Partial<Config>): void => hubPorts().state.write(['config'], {...config(), ...patch})
