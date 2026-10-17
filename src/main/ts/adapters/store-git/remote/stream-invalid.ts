// Only invalid record content can be ignored after retirement. I/O, timeouts and accepted-history failures cannot.
import {Fail} from '../../../lib/index.ts'
export const invalidStream = (why: string): never => {throw Object.assign(new Fail(why), {streamInvalid: true})}
export const isInvalidStream = (e: unknown): boolean => e instanceof Fail && (e as {streamInvalid?: boolean}).streamInvalid === true
