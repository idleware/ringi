// The domains of docs/ARCHITECTURE.md as a rule the build keeps: a module imports only from its own domain and from
// the domains below it. Type-only imports carry no behaviour and may point anywhere.
import {describe, it} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../main/ts')
const BELOW: Record<string, string[]> = {
  lib: [],
  protocol: ['lib'],
  domain: ['protocol', 'lib'],
  store: ['protocol', 'lib'],
  home: ['lib'],
  heartbeat: ['lib'],
  hub: ['domain', 'store', 'home', 'protocol', 'lib'],
  runtime: ['hub', 'heartbeat', 'domain', 'store', 'home', 'protocol', 'lib'],
  app: ['runtime', 'hub', 'heartbeat', 'domain', 'store', 'home', 'protocol', 'lib'],
  // An interface reaches the rest only through app: what the CLI can do, a control panel can do the same way.
  cli: ['app', 'lib'],
  entry: ['cli', 'lib'],
  library: ['app', 'hub', 'domain', 'store', 'protocol', 'lib'],
}
const domainOf = (file: string): string => {
  const rel = path.relative(SRC, file).split(path.sep)
  if (rel.length === 1) return rel[0] === 'cli.ts' ? 'entry' : 'library'
  return rel[0]
}
const files = (d: string): string[] => fs.readdirSync(d, {withFileTypes: true}).flatMap(e =>
  e.isDirectory() ? files(path.join(d, e.name)) : e.name.endsWith('.ts') ? [path.join(d, e.name)] : [])

describe('domains', () => {
  it('import only from themselves and the domains below them', () => {
    const wrong: string[] = []
    for (const file of files(SRC)) {
      const from = domainOf(file)
      assert.ok(BELOW[from], `${path.relative(SRC, file)} is in no domain of docs/ARCHITECTURE.md`)
      for (const m of fs.readFileSync(file, 'utf8').matchAll(/^import\s+(type\s+)?[^'\n]*?from\s+'(\.[^']+)'/gm)) {
        if (m[1]) continue
        const to = domainOf(path.resolve(path.dirname(file), m[2]))
        if (to !== from && !BELOW[from].includes(to)) wrong.push(`${path.relative(SRC, file)} imports ${m[2]} (${from} → ${to})`)
      }
    }
    assert.deepEqual(wrong, [])
  })
})
