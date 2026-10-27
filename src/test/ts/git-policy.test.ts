import {it} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import type {TestContext} from 'node:test'
import {runGit, runGitOk, runGitRaw} from '../../main/ts/adapters/store-git/run.ts'
import {git, networkGit} from '../../main/ts/adapters/store-git/remote/git.ts'
import {gitEnv} from '../../main/ts/adapters/store-git/remote/process.ts'
import type {Handle} from '../../main/ts/adapters/store-git/remote/types.ts'

const fixture = (t: TestContext) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ringi-git-policy-')), repo = path.join(root, 'repo')
  t.after(() => fs.rmSync(root, {recursive: true, force: true}))
  runGit(['init', '-q', '-b', 'main', repo])
  const dir = path.join(repo, '.git'), url = pathToFileURL(path.join(root, 'origin.git')).href
  const H: Handle = {name: 'fixture', dir, d: {schema: 'ringi-hub/3', name: 'fixture', trust: 'asserted', genesis: '',
    store: {type: 'git'}, contract: {path: 'store', remote: 'git+' + url}}}
  const args = (...a: string[]) => ['--git-dir', dir, '--work-tree', repo, ...a]
  const marker = path.join(root, 'executed'), helper = path.join(root, 'helper')
  fs.writeFileSync(helper, `#!/bin/sh\nprintf fixture > '${marker}'\nexit 1\n`, {mode: 0o700})
  return {root, repo, dir, url, H, args, marker, helper}
}

it('overrides an inherited or call-supplied protocol allowlist', () => {
  const old = process.env.GIT_ALLOW_PROTOCOL
  process.env.GIT_ALLOW_PROTOCOL = 'ext'
  try {
    assert.equal(gitEnv().GIT_ALLOW_PROTOCOL, 'file:ssh:https')
    assert.equal(gitEnv({GIT_ALLOW_PROTOCOL: 'ext'}).GIT_ALLOW_PROTOCOL, 'file:ssh:https')
  } finally {if (old === undefined) delete process.env.GIT_ALLOW_PROTOCOL; else process.env.GIT_ALLOW_PROTOCOL = old}
})

it('refuses a local insteadOf rewrite to ext before its helper runs on every Git route', t => {
  const {H, args, marker, helper, url} = fixture(t)
  runGit(args('config', 'protocol.ext.allow', 'always'))
  runGit(args('config', `url.ext::${helper}.insteadOf`, url))
  const fetch = args('fetch', '-q', url), no = /transport 'ext' not allowed/
  assert.throws(() => runGit(fetch), no)
  assert.throws(() => runGitRaw(fetch), no)
  const local = runGitOk(fetch, {env: {GIT_ALLOW_PROTOCOL: 'ext'}})
  assert.notEqual(local.status, 0); assert.match(local.stderr, no)
  const remote = networkGit(H, ['fetch', '-q', url], {ok: true, env: {GIT_ALLOW_PROTOCOL: 'ext'}})
  assert.notEqual(remote.status, 0); assert.match(remote.stderr, no)
  assert.equal(fs.existsSync(marker), false)
})

it('never runs repository fsmonitor commands during local or transport plumbing', t => {
  const {H, args, repo, marker, helper} = fixture(t)
  runGit(args('config', 'core.fsmonitor', helper))
  fs.writeFileSync(path.join(repo, 'file'), 'fixture')
  runGit(args('add', 'file'))
  const tree = runGit(args('write-tree')).trim()
  const sha = runGit(args('commit-tree', tree), {input: 'fixture\n', env: {
    GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@local', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@local'}}).trim()
  runGit(args('update-ref', 'refs/heads/main', sha))
  runGit(args('read-tree', '-u', '--reset', 'HEAD'))
  assert.equal(runGitOk(args('update-index', '--refresh')).status, 0)
  assert.ok(Buffer.isBuffer(runGitRaw(args('read-tree', '-u', '--reset', 'HEAD'))))
  git(H, ['--work-tree', repo, 'update-index', '--refresh'])
  assert.equal(fs.existsSync(marker), false)
})
