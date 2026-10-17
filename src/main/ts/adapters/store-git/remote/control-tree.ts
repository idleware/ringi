// Build a control tree from the last accepted control while preserving chat attachments.
import {fail} from '../../../lib/index.ts'
import {git} from './git.ts'
import {CONTROL_FILES} from './types.ts'
import type {Handle} from './types.ts'

// A tree from `base` with the control files as `control` has them, then `patches` on top.
export const treeWith = (H: Handle, base: string, control: string, patches: Record<string, string>): string => {
  const entries = (sha: string) => new Map(git(H, ['ls-tree', sha]).trim().split('\n').filter(Boolean).map(line => {
    const m = /^(\d+) (\w+) ([0-9a-f]+)\t(.+)$/.exec(line) ?? fail('malformed room tree')
    return [m[4], line] as [string, string]
  }))
  const files = entries(base), kept = entries(control)
  for (const name of CONTROL_FILES) {files.delete(name); if (kept.has(name)) files.set(name, kept.get(name)!)}
  for (const [name, content] of Object.entries(patches)) files.set(name, `100644 blob ${git(H, ['hash-object', '-w', '--stdin'], {input: content}).trim()}\t${name}`)
  return git(H, ['mktree'], {input: [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, line]) => line).join('\n') + '\n'}).trim()
}

