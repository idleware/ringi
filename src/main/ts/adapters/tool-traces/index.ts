// tool-traces: what the tool adapters share to find a session's trace: a session id at the end of a name, directories
// newest first, and when a file was last written.

import fs from 'node:fs'

export const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/
export const newestFirst = (d: string): string[] => { try { return fs.readdirSync(d).sort().reverse() } catch { return [] } }
// Unix seconds, or null when the file is gone.
export const mtime = (f: string): number | null => { try { return fs.statSync(f).mtimeMs / 1000 } catch { return null } }
