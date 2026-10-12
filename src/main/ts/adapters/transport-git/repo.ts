// repo: the store's repository and the contract on its main branch. Every commit is made here (signed on a signed hub),
// every ref moves here compare-and-swap, and the work tree follows the contract so Git clients open the store cleanly.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {fail} from '../../lib/index.ts'
import {mkdirIn} from '../fs/index.ts'
import * as Remote from './remote.ts'
import {ZERO, ident, runGit, runGitOk} from './run.ts'
import type {GitOpt} from './run.ts'
import type {Descriptor} from '../../core/hub/ports/store.ts'
import type {Entry} from '../../core/hub/protocol/files.ts'
import type {SigningContext} from '../../core/signing/index.ts'
import {signCommit} from './signing.ts'

// The store is a repository whose work tree holds the contract (`main`) as it is now, so Git clients (SourceTree, IDEs)
// open `store/` without errors, on the contract, with every room's branch beside it; `git status` stays clean.
export const init = (dir: string, home: string) => runGit(['init', '-q', '-b', 'main', path.dirname(dir)], {where: home})

export class Repo {
  readonly trust: 'asserted' | 'signed'
  readonly dir: string
  readonly d: Descriptor
  readonly home: string
  // The handle remote.ts works on: the repository and what it learned on the last sync.
  readonly h: Remote.Handle
  constructor(hubDir: string, d: Descriptor, home: string, signing?: SigningContext) {
    this.d = d
    this.home = home
    this.trust = d.trust
    this.dir = path.join(hubDir, d.store.path, '.git')
    this.h = {name: d.name, dir: this.dir, d, ...(d.trust === 'signed' && signing ? {signing} : {})}
    if (!fs.existsSync(this.dir)) fail(`hub ${d.name}: no git store at ${this.dir}`)
    this.openable()
  }
  // A store made bare before, or a replica fetched bare, gets its work tree once (and loses the `_ringi` branch of an unreleased build).
  protected openable(): void {
    let changed = false
    if (/^\s*bare\s*=\s*true\s*$/m.test(fs.readFileSync(path.join(this.dir, 'config'), 'utf8'))) { this.git(['config', 'core.bare', 'false']); changed = true }
    if (fs.readFileSync(path.join(this.dir, 'HEAD'), 'utf8') !== 'ref: refs/heads/main\n') { this.git(['symbolic-ref', 'HEAD', 'refs/heads/main']); changed = true }
    if (fs.existsSync(path.join(this.dir, 'refs', 'heads', '_ringi'))) { this.gitOk(['update-ref', '-d', 'refs/heads/_ringi']); changed = true }
    if (changed) this.checkout()
  }
  // The work tree and the index follow the contract, so a Git client sees the store clean.
  protected checkout(): void {
    if (this.rev('refs/heads/main')) this.git(['--work-tree', path.dirname(this.dir), 'read-tree', '-u', '--reset', 'refs/heads/main'])
  }
  protected args(a: string[]) { return ['--git-dir', this.dir, ...a] }
  protected git(a: string[], o?: GitOpt) { return runGit(this.args(a), {...o, where: this.home}) }
  protected gitOk(a: string[], o?: GitOpt) { return runGitOk(this.args(a), o) }
  rev(ref: string): string | null {
    const r = this.gitOk(['rev-parse', '-q', '--verify', `${ref}^{commit}`])
    return r.status === 0 ? r.stdout.trim() : null
  }
  isAncestor(a: string, b: string): boolean { return this.gitOk(['merge-base', '--is-ancestor', a, b]).status === 0 }
  isRef(s: string): boolean { return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(s ?? '') }
  extends(older: string, newer: string): boolean { return older === newer || this.isAncestor(older, newer) }
  // A tree from a base tree without the `drop` paths, with entries put on top; nested paths are fine.
  protected tree(base: string | null, entries: Entry[], drop: string[] = []): string {
    const idx = path.join(this.home, 'tmp', `index.${process.pid}.${crypto.randomBytes(4).toString('hex')}`)
    mkdirIn(this.home, path.dirname(idx))
    const env = {GIT_INDEX_FILE: idx}
    try {
      this.git(['read-tree', ...(base ? [base] : ['--empty'])], {env})
      if (drop.length) this.git(['update-index', '--index-info'], {env, input: drop.map(p => `0 ${ZERO}\t${p}\n`).join('')})
      for (const e of entries) {
        const sha = e.blob ?? this.git(['hash-object', '-w', ...(e.file ? ['--', e.file] : ['--stdin'])], {input: e.content}).trim()
        this.git(['update-index', '--add', '--cacheinfo', `${e.mode},${sha},${e.path}`], {env})
      }
      return this.git(['write-tree'], {env}).trim()
    } finally {
      fs.rmSync(idx, {force: true})
    }
  }
  // Every commit is made here: on a signed hub, signed by its author's key on this machine.
  protected commit(who: string, text: string, tree: string, parents: string[]): string {
    const sha = this.git(['commit-tree', ...(this.h.signing ? [] : Remote.sign(this.h, who, this.home)), tree, ...parents.flatMap(p => ['-p', p])], {input: text, env: ident(who)}).trim()
    return signCommit(this.h, who, sha, this.home)
  }
  protected advance(ref: string, sha: string, old: string | null): boolean {
    if (this.gitOk(['update-ref', ref, sha, old ?? ZERO]).status !== 0) return false
    // A signed hub publishes at once; a rejected push keeps the commit here and alarms (remote.ts).
    return Remote.push(this.h, ref, {behind: !!old && ref !== 'refs/heads/main'})
  }
  sync(): void {
    const main = this.rev('refs/heads/main')
    Remote.sync(this.h)
    if (this.rev('refs/heads/main') !== main) this.checkout()
  }
  contractHead(): string { return this.rev('refs/heads/main') ?? fail(`hub ${this.d.name} has no contract (main)`) }
  contractFile(rev: string, name: string): string | null {
    const r = this.gitOk(['show', `${rev}:${name}`])
    return r.status === 0 ? r.stdout : null
  }
  amendContract(who: string, text: string, files: Record<string, string | Buffer>): string {
    const head = this.contractHead()
    const sha = this.commit(who, text, this.tree(`${head}^{tree}`, Object.entries(files).map(([p, c]) => ({path: p, content: c as string, mode: '100644'}))), [head])
    if (!this.advance('refs/heads/main', sha, head)) fail('the contract moved while amending; retry')
    this.checkout()
    return sha
  }
}
