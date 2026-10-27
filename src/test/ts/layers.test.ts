// The domains of docs/ARCHITECTURE.md as a rule the build keeps. Three roles: core (what ringi is: hub, agents,
// signing), adapters (implementations of core's ports), clients (interfaces); composition alone puts them together.
// Every import counts, type-only ones and re-exports too: a package needs what it names.
import {describe, it} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../main/ts')
// Libraries the adapters share; any adapter may use them, and they use no other adapter.
const SHARED = ['adapters/fs', 'adapters/http']
const ADAPTER = ['core/hub', 'core/agents', 'core/signing', ...SHARED, 'lib']
const RULES: Record<string, string[]> = {
  lib: [],
  'core/signing': ['lib'],
  'core/hub': ['lib'],
  'core/agents': ['core/hub', 'lib'],
  'adapters/fs': ['lib'],
  'adapters/http': ['lib'],
  adapter: ADAPTER,
  'clients/cli': ['core/hub', 'core/agents', 'lib'],
  // The only domain that knows the adapters.
  composition: ['adapter', 'core/hub', 'core/agents', 'core/signing', 'lib'],
  entry: ['composition', 'clients/cli', 'lib'],
  library: ['composition', 'core/hub', 'core/agents', 'lib'],
}
// Modules that only compute: no host (no `node:` module, no `process`).
const PURE = ['lib', 'core/hub/protocol', 'core/hub/work', 'core/hub/decisions', 'core/hub/signals', 'core/signing']

const rel = (file: string) => path.relative(SRC, file).split(path.sep).join('/')
const domainOf = (file: string): string => {
  const r = rel(file)
  if (r === 'cli.ts') return 'entry'
  if (r === 'index.ts') return 'library'
  const [top, sub] = r.split('/')
  if (top === 'core' || top === 'clients') return `${top}/${sub}`
  if (top === 'adapters') return SHARED.includes(`${top}/${sub}`) ? `${top}/${sub}` : 'adapter'
  return top
}
// The adapter a file belongs to, to tell one adapter's own modules from another's.
const adapterOf = (file: string): string | null => /^adapters\/([^/]+)\//.exec(rel(file))?.[1] ?? null
const files = (d: string): string[] => fs.readdirSync(d, {withFileTypes: true}).flatMap(e =>
  e.isDirectory() ? files(path.join(d, e.name)) : e.name.endsWith('.ts') ? [path.join(d, e.name)] : [])
// Every module an import or a re-export names, over as many lines as its braces take, and side-effect imports.
const IMPORT = /^(?:import|export)\s+(?:type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\}|\w+(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+\w+))?)\s+from\s+'([^']+)'|^import\s+'([^']+)'/gm
export const specifiers = (text: string): string[] => [...text.matchAll(IMPORT)].map(m => m[1] ?? m[2])

describe('domains', () => {
  it('import only themselves and the domains below them, types and re-exports included', () => {
    const wrong: string[] = []
    for (const file of files(SRC)) {
      const from = domainOf(file)
      assert.ok(RULES[from], `${rel(file)} is in no domain of docs/ARCHITECTURE.md`)
      for (const spec of specifiers(fs.readFileSync(file, 'utf8')).filter(x => x.startsWith('.'))) {
        const target = path.resolve(path.dirname(file), spec)
        const to = domainOf(target)
        const own = to === from && (from !== 'adapter' || adapterOf(file) === adapterOf(target))
        if (!own && !RULES[from].includes(to)) wrong.push(`${rel(file)} imports ${spec} (${from} → ${to === 'adapter' ? `adapters/${adapterOf(target)}` : to})`)
      }
    }
    assert.deepEqual(wrong, [])
  })

  // Time is not behind a port yet: a fold may default `now` to the clock, lib may wait (sleep) and date (stamp).
  it('keep the host out of the modules that only compute', () => {
    const host = (text: string) => specifiers(text).some(x => x.startsWith('node:')) || /\bprocess\./.test(text)
    const wrong = files(SRC).filter(f => PURE.some(p => rel(f).startsWith(`${p}/`))).filter(f => host(fs.readFileSync(f, 'utf8'))).map(rel)
    assert.deepEqual(wrong, [])
  })

  it('sees imports over several lines, re-exports and side-effect imports', () => {
    const text = [
      `import {\n  hostPosix\n} from '../../../adapters/host-posix/index.ts'`,
      `import 'node:fs'`,
      `import type {\n  Store,\n} from './store.ts'`,
      `export * from './a.ts'`,
      `export {b} from './b.ts'`,
      `import x, {y} from './c.ts'`,
      `export const notAnImport = 1\nconst s = "from './d.ts'"`,
    ].join('\n')
    assert.deepEqual(specifiers(text), ['../../../adapters/host-posix/index.ts', 'node:fs', './store.ts', './a.ts', './b.ts', './c.ts'])
  })
})
