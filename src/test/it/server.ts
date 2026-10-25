// server: a real git forge in docker for the integration tests: a pinned image on free loopback ports, an admin with
// an API token, an organisation and an invitee, and the server's SSH host keys; the container is removed when the test
// ends. Nothing here touches the operator's home, keys or forges.
import type {TestContext} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import crypto from 'node:crypto'
import {spawnSync} from 'node:child_process'

export type Kind = 'forgejo' | 'gitea'
// An image pinned by its exact tag, the CLI it carries and the prefix its settings take from the environment.
const IMAGES: Record<Kind, {image: string, cli: string, env: string}> = {
  forgejo: {image: 'codeberg.org/forgejo/forgejo:13.0.5', cli: 'forgejo', env: 'FORGEJO'},
  gitea: {image: 'docker.gitea.com/gitea:1.25.2', cli: 'gitea', env: 'GITEA'},
}
export const ORG = 'team'
const docker = (...args: string[]) => spawnSync('docker', args, {encoding: 'utf8', timeout: 300_000})
export const dockerAvailable = (): boolean => docker('info', '--format', '{{.ServerVersion}}').status === 0

const freePort = (): Promise<number> => new Promise((done, fail) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const {port} = s.address() as net.AddressInfo
    s.close(() => done(port))
  }).on('error', fail)
})
const until = async (what: string, ready: () => Promise<boolean>, seconds = 120) => {
  for (let i = 0; i < seconds; i++) {
    if (await ready().catch(() => false)) return
    await new Promise(r => setTimeout(r, 1000))
  }
  assert.fail(`${what} was not ready after ${seconds} s`)
}

export type Server = {
  kind: Kind
  http: number
  ssh: number
  // The space ringi makes rooms in: `<kind>://localhost:<port>/team`.
  space: string
  // Files the operator would keep: the root's API token (0600) and the server's SSH host keys as known_hosts lines.
  tokenFile: string
  hostKeyFile: string
  // The server's API as its admin, for what a person would do in its web interface.
  api: <T>(method: string, path: string, body?: unknown) => Promise<{status: number, body: T}>
  // A new account, and a public key put on it as its owner would.
  user: (login: string) => void
  keyOn: (login: string, key: string) => Promise<void>
  // A git push to the room's repository on the server, with this private key, as the server sees it.
  push: (gitDir: string, key: string, room: string, refspec: string) => {status: number | null, err: string}
}

export const server = async (t: TestContext, kind: Kind, base: string): Promise<Server> => {
  const {image, cli, env} = IMAGES[kind], [http, ssh] = [await freePort(), await freePort()]
  const name = `ringi-it-${kind}-${crypto.randomBytes(4).toString('hex')}`
  const set = (k: string, v: string) => ['-e', `${env}__${k}=${v}`]
  const run = docker('run', '-d', '--name', name, '-p', `127.0.0.1:${http}:3000`, '-p', `127.0.0.1:${ssh}:22`,
    ...set('security__INSTALL_LOCK', 'true'), ...set('server__ROOT_URL', `http://localhost:${http}/`), ...set('server__SSH_DOMAIN', 'localhost'),
    ...set('server__SSH_PORT', String(ssh)), ...set('database__DB_TYPE', 'sqlite3'), ...set('service__DISABLE_REGISTRATION', 'true'), image)
  assert.equal(run.status, 0, `docker run ${image}: ${run.stderr}`)
  t.after(() => { docker('rm', '-f', name) })
  const exec = (...args: string[]) => {
    const r = docker('exec', '-u', 'git', name, cli, ...args)
    assert.equal(r.status, 0, `${cli} ${args.slice(0, 3).join(' ')}: ${r.stderr}`)
    return r.stdout.trim()
  }
  await until(`${kind} on port ${http}`, async () => (await fetch(`http://127.0.0.1:${http}/api/v1/version`)).ok)
  exec('admin', 'user', 'create', '--admin', '--username', 'root', '--password', 'Root-pass-12345', '--email', 'root@it.test', '--must-change-password=false')
  const token = exec('admin', 'user', 'generate-access-token', '--username', 'root', '--token-name', 'it', '--scopes', 'all', '--raw').split('\n').at(-1)!
  const tokenFile = path.join(base, 'token'), hostKeyFile = path.join(base, 'known_hosts')
  fs.writeFileSync(tokenFile, token + '\n', {mode: 0o600})
  const keys = docker('exec', name, 'sh', '-c', 'cat /data/ssh/ssh_host_*_key.pub')
  assert.equal(keys.status, 0, keys.stderr)
  fs.writeFileSync(hostKeyFile, keys.stdout.trim().split('\n').map(k => `[localhost]:${ssh} ${k.split(' ').slice(0, 2).join(' ')}`).join('\n') + '\n')
  await until(`${kind} SSH on port ${ssh}`, async () => spawnSync('ssh-keyscan', ['-p', String(ssh), '127.0.0.1'], {encoding: 'utf8', timeout: 5000}).stdout.includes('ssh-'), 60)
  const api = async <T>(method: string, p: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${http}/api/v1${p}`, {method, headers: {Authorization: `token ${token}`, 'Content-Type': 'application/json'},
      ...(body === undefined ? {} : {body: JSON.stringify(body)})})
    const text = await r.text()
    return {status: r.status, body: (text ? JSON.parse(text) : null) as T}
  }
  const org = await api('POST', '/orgs', {username: ORG, visibility: 'private'})
  assert.equal(org.status, 201, `organisation ${ORG}: ${JSON.stringify(org.body)}`)
  return {kind, http, ssh, space: `${kind}://localhost:${http}/${ORG}`, tokenFile, hostKeyFile, api,
    user: login => { exec('admin', 'user', 'create', '--username', login, '--password', `${login}-pass-12345`, '--email', `${login}@it.test`, '--must-change-password=false') },
    keyOn: async (login, key) => {
      const r = await api('POST', `/admin/users/${login}/keys`, {title: `${login}'s machine`, key: key.trim().split(/\s+/).slice(0, 2).join(' ')})
      assert.equal(r.status, 201, `key on ${login}: ${JSON.stringify(r.body)}`)
    },
    push: (gitDir, key, room, refspec) => {
      const sshCommand = `ssh -i ${key} -o IdentitiesOnly=yes -o UserKnownHostsFile=${hostKeyFile} -o StrictHostKeyChecking=yes`
      const r = spawnSync('git', ['--git-dir', gitDir, 'push', '--porcelain', `ssh://git@localhost:${ssh}/${ORG}/${room}.git`, refspec],
        {encoding: 'utf8', timeout: 60_000, env: {...process.env, GIT_SSH_COMMAND: sshCommand, GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0'}})
      return {status: r.status, err: r.stderr + r.stdout}
    },
  }
}
