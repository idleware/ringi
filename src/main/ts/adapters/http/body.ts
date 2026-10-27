// Bound decoded response bytes before parsing, including a response sent without a Content-Length header.
import {fail} from '../../lib/index.ts'

export const responseBody = async (r: Response, limit: number, signal: AbortSignal, reader: (r: ReadableStreamDefaultReader<Uint8Array>) => void): Promise<string> => {
  if (!r.body) return ''
  const stream = r.body.getReader(); reader(stream)
  const declared = r.headers.get('content-length')
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > limit) fail(`API response exceeds ${limit} bytes`)
  const bytes = new Uint8Array(limit)
  let length = 0
  while (true) {
    signal.throwIfAborted()
    const {done, value} = await stream.read()
    if (done) break
    if (length + value.byteLength > limit) fail(`API response exceeds ${limit} bytes`)
    bytes.set(value, length); length += value.byteLength
  }
  return new TextDecoder().decode(bytes.subarray(0, length))
}
