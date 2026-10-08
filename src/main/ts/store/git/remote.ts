// Signed remote hubs for ringi. The remote is an untrusted replica, never a trust anchor.
// Fetch into staging refs, verify against an out-of-band root pin and a root-signed room roster,
// then advance local/accepted refs. Private keys stay under this machine's RINGI_HOME.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import {spawnSync} from 'node:child_process'
import type {SpawnSyncReturns} from 'node:child_process'
import * as C from '../../lib/index.ts'
import * as P from '../../protocol/index.ts'
import type {Descriptor, Member} from '../index.ts'

export type Handle = {name: string, dir: string, d: Descriptor, main?: string, remoteAlarms?: Record<string, string>, bootstrap?: boolean}
export type Room = {name: string, head: string, genesis: string, control: string, log: (who: string) => string, archived?: boolean, members?: Record<string, Member>}
type Key = {line: string, fp: string}
type Signer = {principal: string, key: Key}
type VerifiedRoom = {genesis: string, entries: Signer[], members: Record<string, Member>}
type CommandOpt = {input?: string | Buffer, env?: NodeJS.ProcessEnv, ok?: boolean, raw?: boolean}
const reason = (e: unknown): string => e instanceof Error ? e.message : String(e)

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const ROOT = 'operator'
const TRACK = 'refs/remotes/origin/'
const ACCEPT = 'refs/ringi/remote-accepted/'
const TAGS = 'refs/tags/ringi/'
const TAG_TRACK = 'refs/ringi/remote-tags/'
const TAG_ACCEPT = 'refs/ringi/remote-accepted-tags/'
const ENV = {GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', LC_ALL: 'C'}
const BASE = ['-c', 'core.hooksPath=' + os.devNull, '-c', 'gpg.format=ssh', '-c', 'gpg.ssh.program=ssh-keygen',
  '-c', 'color.ui=false', '-c', 'log.showSignature=false', '-c', 'core.quotePath=false',
  '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always', '-c', 'protocol.ssh.allow=always',
  '-c', 'protocol.https.allow=always', '-c', 'http.followRedirects=false']
const verified = new Set<string>()
// Reuse immutable-head checks within one operation; no ref or alarm survives into the next one.
const checking = new WeakMap<Handle, Map<string, unknown>>()
export const withVerification = <T>(H: Handle, fn: () => T): T => {
  if (checking.has(H)) return fn()
  checking.set(H, new Map())
  try { return fn() } finally { checking.delete(H) }
}
const memo = <T>(H: Handle, key: string, fn: () => T): T => {
  const cache = checking.get(H)
  if (cache?.has(key)) return cache.get(key) as T
  const value = fn()
  cache?.set(key, value)
  return value
}
const {note, strictJson} = C
export {strictJson}
const mkdir = (d: string) => fs.mkdirSync(d, {recursive: true, mode: 0o700})
const id = (s: string): string => P.ID_RE.test(s) ? s : C.fail(`bad agent or hub id ${s}`)
const zero = (H: Handle): string => '0'.repeat(git(H, ['rev-parse', '--show-object-format']).trim() === 'sha256' ? 64 : 40)
const ident = (who: string): NodeJS.ProcessEnv => ({GIT_AUTHOR_NAME: who, GIT_AUTHOR_EMAIL: `${who}@ringi`, GIT_COMMITTER_NAME: who, GIT_COMMITTER_EMAIL: `${who}@ringi`})
export const gitEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GIT_CONFIG_|GIT_DIR$|GIT_WORK_TREE$|GIT_INDEX_FILE$|GIT_OBJECT_DIRECTORY$|GIT_ALTERNATE_OBJECT_DIRECTORIES$|GIT_REPLACE_REF_BASE$)/.test(k))),
  ...ENV, ...extra,
})
function command(cmd: string, args: string[], opt: CommandOpt & {ok: true}): SpawnSyncReturns<string>
function command(cmd: string, args: string[], opt: CommandOpt & {raw: true}): Buffer
function command(cmd: string, args: string[], opt?: CommandOpt): string
function command(cmd: string, args: string[], opt: CommandOpt = {}): string | Buffer | SpawnSyncReturns<string | Buffer> {
  const r = spawnSync(cmd, args, {input: opt.input, encoding: opt.raw ? 'buffer' : 'utf8', env: gitEnv(opt.env),
    maxBuffer: 64 * 1024 * 1024, timeout: 30000})
  if (r.error && !opt.ok) C.fail(`${cmd}: ${r.error.message}`)
  if (r.status !== 0 && !opt.ok) C.fail(`${cmd}: ${String(r.stderr || r.error?.message || r.signal || 'failed').trim().split('\n').at(-1)}`)
  return opt.ok ? r : r.stdout
}
// Use the same isolated Git invocation for signatures and transport, even if the CLI wrapper's env differs.
function git(H: Handle, args: string[], opt: CommandOpt & {ok: true}): SpawnSyncReturns<string>
function git(H: Handle, args: string[], opt: CommandOpt & {raw: true}): Buffer
function git(H: Handle, args: string[], opt?: CommandOpt): string
function git(H: Handle, args: string[], opt?: CommandOpt): string | Buffer | SpawnSyncReturns<string> {
  return command('git', ['--git-dir', H.dir, ...BASE, ...args], opt)
}
const config = (H: Handle, key: string, value?: string): string => value === undefined
  ? String(git(H, ['config', '--get', key], {ok: true}).stdout || '').trim()
  : git(H, ['config', key, String(value)])
const rev = (H: Handle, ref: string): string | null => {
  const r = git(H, ['rev-parse', '-q', '--verify', `${ref}^{commit}`], {ok: true})
  return r.status === 0 ? r.stdout.trim() : null
}
const object = (H: Handle, ref: string): string | null => {
  const r = git(H, ['rev-parse', '-q', '--verify', ref], {ok: true})
  return r.status === 0 ? r.stdout.trim() : null
}
const ancestor = (H: Handle, a: string, b: string): boolean => !!a && !!b && git(H, ['merge-base', '--is-ancestor', a, b], {ok: true}).status === 0
export const isRemote = (H: Handle): boolean => {
  if (H.d.trust !== 'signed' && H.d.trust !== 'asserted') C.fail(`unsupported hub trust ${String(H.d.trust)}`)
  return H.d.trust === 'signed'
}
const origin = (H: Handle): string | undefined => H.d.store.remote
const suffix = (ref: string): string => ref.replace(/^refs\/heads\//, '')
const accepted = (ref: string): string => ACCEPT + suffix(ref)
const tracking = (ref: string): string => TRACK + suffix(ref)

// Transport and home state use the same owner-aware lock.
const locked = <T>(H: Handle, fn: () => T): T => {
  const file = path.join(H.dir, 'ringi', 'transport.lock')
  mkdir(path.dirname(file))
  return C.locked(file, () => withVerification(H, fn))
}

export const parseKey = (value: unknown): Key => {
  const text = String(value || '').trim()
  const m = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) ([A-Za-z0-9+/]+={0,2})(?: [^\r\n]*)?$/.exec(text) ?? C.fail('expected one SSH public key (or a file containing it)')
  if (m[2].length > 16384) C.fail('expected one SSH public key (or a file containing it)')
  const data = Buffer.from(m[2], 'base64')
  if (data.length < 8 || data.readUInt32BE(0) > data.length - 4 || data.subarray(4, 4 + data.readUInt32BE(0)).toString() !== m[1]) C.fail('malformed SSH public key')
  const line = `${m[1]} ${m[2]}`
  return {line, fp: 'SHA256:' + crypto.createHash('sha256').update(data).digest('base64').replace(/=+$/, '')}
}
const keyInput = (value: string): Key => parseKey(fs.existsSync(value) && fs.statSync(value).isFile() ? fs.readFileSync(value, 'utf8') : value)
const rootKey = (H: Handle): Key => parseKey(H.d.root || C.fail(`hub ${H.name} has no out-of-band root pin; use hub add --root <public-key|file>`))
const signerLine = (who: string, key: Key): string => `${who} namespaces="git" ${key.line}\n`
const keyPath = (H: Handle, who: string, home: string): string => path.join(home, 'keys', id(H.name), id(who))
const localKey = (H: Handle, who: string, home: string, create = false): Key & {file: string} => {
  const file = keyPath(H, who, home)
  if (!fs.existsSync(file)) {
    if (!create) C.fail(`no private key for ${who} on this machine; ${who === ROOT ? 'root keys are never obtained from a hub' : 'join here to generate one, then ask the root to admit its public key'}`)
    mkdir(path.dirname(file))
    command('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `${who}@ringi`, '-f', file])
  }
  // Derive from the private key instead of trusting a mutable .pub sidecar.
  const key = parseKey(command('ssh-keygen', ['-y', '-f', file]))
  return {...key, file}
}

export const setupSigned = (H: Handle, home: string, url?: string): {root: string, allowedSigners: string} => {
  id(H.name)
  if (rev(H, 'refs/heads/main')) C.fail('setupSigned only initializes an empty hub; it cannot replace an existing trust anchor')
  const key = localKey(H, ROOT, home, true)
  H.d.trust = 'signed'
  H.d.root = key.line
  config(H, 'gpg.format', 'ssh')
  config(H, 'gpg.ssh.program', 'ssh-keygen')
  if (url) {
    checkUrl(url)
    H.d.store.remote = url
  }
  return {root: key.line, allowedSigners: signerLine(ROOT, key)}
}
export const sign = (H: Handle, who: string, home: string): string[] => {
  if (!isRemote(H)) return []
  const key = localKey(H, who, home)
  if (who === ROOT && key.line !== rootKey(H).line) C.fail('the local operator key does not match this hub\'s pinned root')
  config(H, 'gpg.format', 'ssh')
  config(H, 'gpg.ssh.program', 'ssh-keygen')
  return [`-S${key.file}`]
}
export const rootRoster = (H: Handle): string => signerLine(ROOT, rootKey(H))
const checkUrl = (url: string): void => {
  if (typeof url !== 'string' || /[\r\n\0]/.test(url) || url.startsWith('-') || /^http:\/\//i.test(url) || !/^(?:file|https|ssh):\/\/|^(?:[^\s/@:]+@)?[^\s/:]+:[^\s]+$|^\//.test(url)) C.fail('use a file://, https:// or ssh Git URL; cleartext HTTP and custom transport helpers are refused')
}

const blobText = (H: Handle, sha: string, name: string): string => {
  const entry = git(H, ['ls-tree', sha, '--', name]).trim()
  if (!/^100(?:644|755) blob [0-9a-f]+\t/.test(entry)) C.fail(`${name} at ${sha.slice(0, 12)} must be a regular blob`)
  const raw = git(H, ['cat-file', 'blob', `${sha}:${name}`], {raw: true})
  const d = P.decodeText(raw)
  if (d.invalid) C.fail(`${name} at ${sha.slice(0, 12)} is ${d.invalid}`)
  return d.text!
}
const rosterAt = (H: Handle, sha: string): {entries: Signer[], members: Record<string, Member>} => {
  const entries = blobText(H, sha, 'allowed_signers').split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#')).map(line => {
    const m = /^(\S+) namespaces="git" (.+)$/.exec(line) ?? C.fail('malformed allowed_signers; only literal principals and git namespace are supported')
    if (!P.ID_RE.test(m[1])) C.fail('malformed allowed_signers; only literal principals and git namespace are supported')
    return {principal: m[1], key: parseKey(m[2])}
  })
  const keys = new Set<string>(), principals = new Set<string>()
  for (const e of entries) {
    if (keys.has(e.key.fp) || principals.has(e.principal)) C.fail('duplicate key or principal in allowed_signers; rotation requires an explicit revocation protocol')
    keys.add(e.key.fp); principals.add(e.principal)
  }
  const members = strictJson<Record<string, Member>>(blobText(H, sha, 'members.json'), 'members.json')
  if (!members || typeof members !== 'object' || Array.isArray(members)) C.fail('members.json must be an object')
  if (entries.find(e => e.principal === ROOT)?.key.line !== rootKey(H).line || members[ROOT]?.role !== 'root') C.fail('room roster must retain the pinned operator as root')
  if (Object.keys(members).some(who => !P.ID_RE.test(who) || !principals.has(who) || (who !== ROOT && members[who]?.role === 'root')) || entries.some(e => !members[e.principal])) C.fail('members.json and allowed_signers disagree')
  return {entries, members}
}
const signerFile = (H: Handle, text: string): string => {
  const dir = path.join(H.dir, 'ringi', 'verify')
  mkdir(dir)
  const file = path.join(dir, crypto.createHash('sha256').update(text).digest('hex') + '.allowed_signers')
  if (!fs.existsSync(file)) fs.writeFileSync(file, text, {flag: 'wx', mode: 0o600})
  else if (fs.readFileSync(file, 'utf8') !== text) C.fail('local signature verification cache was changed')
  return file
}
const checkSignature = (H: Handle, sha: string, who: string, key: Key, kind: 'commit' | 'tag' = 'commit'): void => {
  const cache = `${kind}/${sha}/${who}/${key.fp}`
  if (verified.has(cache)) return
  const file = signerFile(H, signerLine(who, key))
  const r = git(H, ['-c', `gpg.ssh.allowedSignersFile=${file}`, '-c', 'gpg.ssh.revocationFile=' + os.devNull, `verify-${kind}`, sha], {ok: true})
  if (r.status !== 0) C.fail(`bad or missing signature at ${sha.slice(0, 12)}: not signed by the admitted key of ${who}`)
  const raw = git(H, ['cat-file', kind, sha], {raw: true})
  const split = raw.indexOf(Buffer.from('\n\n'))
  if (split < 0) C.fail(`malformed ${kind}`)
  const hdr = raw.subarray(0, split).toString('utf8')
  if (/^encoding (?!UTF-8$|utf-8$)/m.test(hdr)) C.fail('commit declares a non-UTF-8 message')
  const d = P.decodeText(raw.subarray(split + 2))
  if (d.invalid) C.fail(`${kind} message is ${d.invalid}`)
  verified.add(cache)
  if (verified.size > 4096) verified.delete(verified.values().next().value!)
}
type Commit = {sha: string, parents: string[]}
const chain = (H: Handle, head: string, base?: string): Commit[] => git(H, ['rev-list', '--parents', '--reverse', '--topo-order', head, ...(base ? [`^${base}`] : [])]).trim().split('\n').filter(Boolean).map(line => {
  const [sha, ...parents] = line.split(' ')
  return {sha, parents}
})
const linear = (commits: Commit[], initial: string | null, check: (sha: string) => void): void => {
  let expect = initial
  for (const {sha, parents: ps} of commits) {
    if (ps.length > 1 || (ps[0] || null) !== expect) C.fail(`history is not linear at ${sha.slice(0, 12)}`)
    check(sha)
    expect = sha
  }
}
const verifyMain = (H: Handle, head: string): {head: string, genesis: string, commits: string[]} => memo(H, `main/${head}`, () => {
  const key = rootKey(H)
  const commits = chain(H, head)
  if (!commits.length) C.fail('signed hub has no genesis')
  const pin = H.d.genesis
  if (!pin && !H.bootstrap) C.fail(`hub ${H.name} has no pinned genesis`)
  if (pin && commits[0].sha !== pin) C.fail('hub does not descend from the pinned genesis')
  linear(commits, null, sha => {
    checkSignature(H, sha, ROOT, key)
    // The shared contract is contract.json; hubs made before the rename carry it as hub.json.
    const name = git(H, ['cat-file', '-e', `${sha}:contract.json`], {ok: true}).status === 0 ? 'contract.json' : 'hub.json'
    const meta = strictJson<{schema: string, trust: string, root: string}>(blobText(H, sha, name), name)
    if (meta.schema !== 'ringi-hub' || meta.trust !== 'signed' || parseKey(meta.root).line !== key.line) C.fail(`${name} must declare signed trust and the pinned root key`)
    const authority = git(H, ['cat-file', '-e', `${sha}:authority.json`], {ok: true})
    if (authority.status === 0) strictJson(blobText(H, sha, 'authority.json'), 'authority.json')
  })
  if (!pin) H.d.genesis = commits[0].sha
  H.bootstrap = false
  return {head, genesis: commits[0].sha, commits: commits.map(c => c.sha)}
})
export const verifyHub = (H: Handle) => {
  if (!isRemote(H)) return null
  const head = rev(H, 'refs/heads/main') || C.fail('signed hub has no main')
  return verifyMain(H, head)
}
const roomData = (H: Handle, name: string, head: string, expectedGenesis?: string): VerifiedRoom => {
  const data = memo(H, `room/${head}`, () => {
    const main = verifyHub(H) ?? C.fail('room verification requires a signed hub')
    const commits = chain(H, head, main.head)
    if (!commits.length) C.fail(`room ${name} has no control genesis`)
    const firstParents = commits[0].parents
    if (firstParents.length !== 1 || !main.commits.includes(firstParents[0])) C.fail('room control does not descend from the verified hub contract')
    let prev: Signer[] = []
    let current: {entries: Signer[], members: Record<string, Member>} | undefined
    linear(commits, firstParents[0], sha => {
      checkSignature(H, sha, ROOT, rootKey(H))
      current = rosterAt(H, sha)
      const next = current
      for (const e of prev) if (!next.entries.some(n => n.principal === e.principal && n.key.line === e.key.line)) C.fail('room roster drops or changes an admitted key; revocation/freeze is not implemented')
      prev = current.entries
    })
    return {genesis: commits[0].sha, subject: git(H, ['show', '-s', '--format=%B', commits[0].sha]).split('\n')[0], ...current!}
  })
  // A ref name is supplied by the replica; only the signed genesis names the room.
  if (data.subject !== `room ${name}`) C.fail(`room genesis subject must be "room ${name}"`)
  if (expectedGenesis && data.genesis !== expectedGenesis) C.fail('room control changed its genesis')
  return data
}
export const verifyRoom = (H: Handle, R: Room): VerifiedRoom => {
  if (!isRemote(H)) C.fail('room verification requires a signed hub')
  if (H.remoteAlarms?.[R.control]) C.fail(`ALARM ${H.remoteAlarms[R.control]}; room is quarantined`)
  return roomData(H, R.name, R.head, R.genesis)
}
const verifyLog = (H: Handle, R: Pick<Room, 'name' | 'head' | 'genesis'>, who: string, head: string): Set<string> => memo(H, `log/${R.name}/${R.head}/${R.genesis}/${who}/${head}`, () => {
  const room = roomData(H, R.name, R.head, R.genesis)
  const signer = room.entries.find(e => e.principal === who) ?? C.fail(`unadmitted key/principal ${who}`)
  if (!ancestor(H, R.genesis, head)) C.fail('log does not descend from the room genesis')
  const commits = chain(H, head, R.genesis)
  linear(commits, R.genesis, sha => checkSignature(H, sha, who, signer.key))
  return new Set(commits.map(c => c.sha))
})
export const verify = (H: Handle, R: Room, who: string, head: string): string | null => {
  if (!isRemote(H)) return null
  const alarm = H.remoteAlarms?.[R.log(who)]
  if (alarm) return alarm
  try { verifyRoom(H, R); verifyLog(H, R, who, head); return null } catch (e) { return reason(e) }
}

const signalName = (ref: string): {genesis: string, actor: string, message: string, signal: string} => {
  const parts = ref.startsWith(TAGS) ? ref.slice(TAGS.length).split('/') : []
  const [genesis, actor, name = ''] = parts
  const dot = name.indexOf('.'), message = name.slice(0, dot), signal = name.slice(dot + 1)
  if (parts.length !== 3 || !SHA.test(genesis) || !P.ID_RE.test(actor) || !SHA.test(message) || !/^[a-z][a-z0-9.-]*$/.test(signal)) C.fail('malformed signal tag namespace')
  return {genesis, actor, message, signal}
}
// The transport binds a signed tag to an accepted message. Derived signals belong to the message's author;
// read/taken marks may name another member's message. Readers check the transition or mark's meaning (signals.ts).
const checkSignal = (H: Handle, R: Room, ref: string, sha: string): void => {
  const s = signalName(ref)
  if (s.genesis !== R.genesis) C.fail('signal belongs to another room genesis')
  if (git(H, ['cat-file', '-t', sha]).trim() !== 'tag') C.fail('signal must be an annotated tag')
  const text = P.decodeText(git(H, ['cat-file', 'tag', sha], {raw: true}))
  if (text.invalid) C.fail(`signal tag is ${text.invalid}`)
  const [header, ...rest] = text.text!.split('\n\n')
  const target = /^object ([0-9a-f]+)\ntype commit\ntag ([^\n]+)\ntagger ([^<\n]+) <[^\n]*> \d+ [+-]\d{4}\n?$/.exec(header) ?? C.fail('malformed signal tag headers')
  if (target[1] !== s.message || target[2] !== ref.slice('refs/tags/'.length) || target[3].trim() !== s.actor) C.fail('signal tag name, actor or target disagrees')
  const body = rest.join('\n\n').split('-----BEGIN SSH SIGNATURE-----')[0].trimEnd()
  if (body !== `${s.signal}\n\nRoom: ${R.name}\nGenesis: ${R.genesis}\nActor: ${s.actor}\nMessage: ${s.message}\nSignal: ${s.signal}`) C.fail('signal tag trailers disagree with its namespace or target')
  const roster = verifyRoom(H, R)
  const signer = roster.entries.find(e => e.principal === s.actor) ?? C.fail(`unadmitted signal principal ${s.actor}`)
  checkSignature(H, sha, s.actor, signer.key, 'tag')
  const mark = s.signal === 'read' || s.signal === 'taken'
  if (s.message === R.genesis) C.fail('signal points at no message of this room')
  const authors = memo(H, `authors/${R.name}/${R.head}/${R.genesis}`, () => {
    const by = new Map<string, Set<string>>()
    const heads = refs(H, `refs/heads/${R.name}/log/`)
    for (const {principal: who} of roster.entries) {
      const head = heads.get(R.log(who))
      if (!head || H.remoteAlarms?.[R.log(who)]) continue
      try {
        for (const sha of verifyLog(H, R, who, head)) {
          const owners = by.get(sha) ?? new Set<string>()
          owners.add(who)
          by.set(sha, owners)
        }
      } catch { /* a quarantined or invalid log cannot supply a signal target */ }
    }
    return by
  }).get(s.message)
  if (!(mark ? authors?.size : authors?.has(s.actor))) C.fail(`signal points at no accepted message ${mark ? 'of this room' : 'of its actor'}`)
}
export const verifySignal = (H: Handle, R: Room, ref: string, sha: string): string | null => {
  if (!isRemote(H)) return null
  const alarm = H.remoteAlarms?.[ref]
  if (alarm) return alarm
  try { checkSignal(H, R, ref, sha); return null } catch (e) { return reason(e) }
}

const refs = (H: Handle, prefix: string): Map<string, string> => new Map(git(H, ['for-each-ref', '--format=%(refname) %(objectname)', prefix]).trim().split('\n').filter(Boolean).map(s => s.split(' ') as [string, string]))
const pushAlarms = (H: Handle): Record<string, string> => strictJson(config(H, 'ringi.pushAlarms') || '{}', 'local push alarm state')
// The local accepted transport refs survive reader resets and retain evidence of remote rewrites/deletions.
const promote = (H: Handle, ref: string, sha: string): void => {
  const acc = rev(H, accepted(ref))
  const cur = rev(H, ref)
  if (acc && !ancestor(H, acc, sha)) C.fail(`${suffix(ref)} was rewritten or rolled back from ${acc.slice(0, 12)} to ${sha.slice(0, 12)}`)
  if (cur && cur !== sha && !ancestor(H, cur, sha) && !ancestor(H, sha, cur)) C.fail(`${suffix(ref)} diverges from the local accepted history`)
  if (!cur || (cur !== sha && ancestor(H, cur, sha))) git(H, ['update-ref', ref, sha, cur || zero(H)])
  git(H, ['update-ref', accepted(ref), sha, acc || zero(H)])
}
const syncUnlocked = (H: Handle): Handle => {
  H.remoteAlarms = {...pushAlarms(H)}
  const url = origin(H)
  if (!url) { if (rev(H, 'refs/heads/main')) verifyHub(H); return H }
  checkUrl(url)
  git(H, ['-c', 'fetch.fsckObjects=true', 'fetch', '-q', '--no-tags', '--prune', url,
    `+refs/heads/*:${TRACK}*`, `+${TAGS}*:${TAG_TRACK}*`])
  const fetched = refs(H, TRACK)
  const main = fetched.get(TRACK + 'main') || C.fail('ALARM remote main was deleted or is missing; refusing authority from the hub')
  try { verifyMain(H, main); promote(H, 'refs/heads/main', main) } catch (e) { C.fail(`ALARM hub ${H.name}: ${reason(e)}; nothing is delivered`) }
  H.main = rev(H, 'refs/heads/main')!
  const controls = new Set([...fetched.keys(), ...refs(H, ACCEPT).keys()].map(r => r.slice(r.startsWith(TRACK) ? TRACK.length : ACCEPT.length)).filter(r => /^[^/]+\/control$/.test(r)))
  const rooms = new Map<string, Room>()
  const byGenesis = new Map<string, Room>()
  for (const ctl of controls) {
    const name = ctl.split('/')[0]
    const ref = 'refs/heads/' + ctl
    try {
      if (!P.ID_RE.test(name)) C.fail('invalid room name')
      const sha = fetched.get(TRACK + ctl) ?? C.fail(`${ctl} was deleted on the remote`)
      const data = roomData(H, name, sha)
      if (byGenesis.has(data.genesis)) C.fail('room genesis is already bound to another room')
      promote(H, ref, sha)
      const head = rev(H, ref)!
      const R: Room = {name, head, genesis: data.genesis, control: ref, log: who => `refs/heads/${name}/log/${who}`}
      rooms.set(name, R)
      byGenesis.set(data.genesis, R)
    } catch (e) { H.remoteAlarms[ref] = reason(e) }
  }
  const logs = new Set([...fetched.keys(), ...refs(H, ACCEPT).keys()].map(r => r.slice(r.startsWith(TRACK) ? TRACK.length : ACCEPT.length)).filter(r => /^[^/]+\/log\/[^/]+$/.test(r)))
  for (const log of logs) {
    const [name, , who] = log.split('/')
    const ref = 'refs/heads/' + log
    try {
      if (!P.ID_RE.test(who)) C.fail('invalid log principal')
      const R = rooms.get(name) ?? C.fail(`${name}/control is missing or quarantined`)
      const sha = fetched.get(TRACK + log) ?? C.fail(`${log} was deleted on the remote`)
      verifyLog(H, R, who, sha)
      promote(H, ref, sha)
    } catch (e) { H.remoteAlarms[ref] = reason(e) }
  }
  const tags = refs(H, TAG_TRACK), pinned = refs(H, TAG_ACCEPT)
  for (const name of new Set([...tags.keys()].map(r => r.slice(TAG_TRACK.length)).concat([...pinned.keys()].map(r => r.slice(TAG_ACCEPT.length))))) {
    const ref = TAGS + name
    try {
      const sha = tags.get(TAG_TRACK + name) ?? C.fail('signal was deleted on the remote after acceptance')
      const s = signalName(ref)
      const R = byGenesis.get(s.genesis) ?? C.fail('signal room is missing or quarantined')
      checkSignal(H, R, ref, sha)
      const acc = pinned.get(TAG_ACCEPT + name), cur = object(H, ref)
      if (acc && acc !== sha) C.fail('signal was replaced after transport acceptance')
      if (cur && cur !== sha) C.fail('signal diverges from the local tag object')
      git(H, ['update-ref', ref, sha, cur ?? zero(H)])
      git(H, ['update-ref', TAG_ACCEPT + name, sha, acc ?? zero(H)])
    } catch (e) { H.remoteAlarms[ref] = reason(e) }
  }
  for (const [ref, why] of Object.entries(H.remoteAlarms)) note(`ALARM ${suffix(ref)}: ${why}; quarantined and withheld`)
  return H
}
export const sync = (H: Handle): Handle => !isRemote(H) ? H : locked(H, () => syncUnlocked(H))

export const hubAdd = ({home, name, url, root, genesis}: {home: string, name: string, url: string, root?: string, genesis?: string}): string => {
  id(name); checkUrl(url)
  if (!root) C.fail('hub add requires --root <public-key|file> from the operator; a key advertised by the hub is not a trust anchor')
  const key = keyInput(root ?? C.fail('hub add requires --root <public-key|file>'))
  if (genesis && !SHA.test(genesis)) C.fail('--genesis must be a full commit id')
  // A hub is a descriptor (hub.json) beside its store; for a git store the repository is store/.git.
  const hubDir = path.join(home, 'hub', name)
  const dir = path.join(hubDir, 'store', '.git')
  if (fs.existsSync(hubDir)) C.fail(`hub ${name} exists`)
  mkdir(path.dirname(dir))
  const stage = path.join(home, 'hub', `.${name}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.git`)
  try {
    command('git', ['init', '--bare', '-q', '-b', 'main', stage])
    const descriptor: Descriptor = {schema: 'ringi-hub/2', name, trust: 'signed', root: key.line, genesis,
      store: {type: 'git', path: 'store', remote: url}}
    const H: Handle = {name, dir: stage, d: descriptor, bootstrap: !genesis}
    sync(H)
    fs.renameSync(stage, dir)
    fs.writeFileSync(path.join(hubDir, 'hub.json'), JSON.stringify(descriptor, null, 2) + '\n', {mode: 0o600})
    return dir
  } finally {
    if (fs.existsSync(stage)) fs.rmSync(stage, {recursive: true, force: true})
    // A failed add leaves no half-made hub behind (the directory did not exist before).
    if (!fs.existsSync(dir)) fs.rmSync(hubDir, {recursive: true, force: true})
  }
}

export const join = (H: Handle, R: Room, who: string, home: string) => {
  const room = verifyRoom(H, R)
  const key = locked(H, () => localKey(H, who, home, true))
  const admitted = !!room.entries.find(e => e.principal === who && e.key.line === key.line)
  return {publicKey: key.line, fingerprint: key.fp, admitted}
}
const treeWith = (H: Handle, head: string, patches: Record<string, string>): string => {
  const files = new Map(git(H, ['ls-tree', head]).trim().split('\n').filter(Boolean).map(line => {
    const m = /^(\d+) (\w+) ([0-9a-f]+)\t(.+)$/.exec(line) ?? C.fail('malformed control tree')
    return [m[4], `${m[1]} ${m[2]} ${m[3]}\t${m[4]}`] as [string, string]
  }))
  for (const [name, content] of Object.entries(patches)) files.set(name, `100644 blob ${git(H, ['hash-object', '-w', '--stdin'], {input: content}).trim()}\t${name}`)
  return git(H, ['mktree'], {input: [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, line]) => line).join('\n') + '\n'}).trim()
}
export const roomAdmit = (H: Handle, R: Room, who: string, publicKey: string, home: string): string => {
  id(who)
  if (!isRemote(H)) C.fail('room admit is for signed hubs; local membership is added by join')
  if (who === ROOT) C.fail('the root is already pinned; root replacement requires a separate trust transition')
  if (R.archived) C.fail('cannot admit into an archived room')
  const room = verifyRoom(H, R)
  const key = keyInput(publicKey)
  if (room.entries.some(e => e.principal === who || e.key.fp === key.fp)) C.fail('principal or key is already admitted; key rotation is not implemented')
  const head = rev(H, R.control) ?? C.fail('room control is missing')
  if (head !== R.head) C.fail('room control moved while admitting; retry')
  const members = {...room.members, [who]: {role: 'member', since: new Date().toISOString()}}
  const roster = [...room.entries.map(e => signerLine(e.principal, e.key)), signerLine(who, key)].join('')
  const tree = treeWith(H, head, {'members.json': JSON.stringify(members, null, 2) + '\n', allowed_signers: roster})
  const sha = git(H, ['commit-tree', ...sign(H, ROOT, home), tree, '-p', head], {
    input: P.compose(`admit ${who}`, [['To', '*'], ['Kind', 'room'], ['Key', key.fp]]), env: ident(ROOT),
  }).trim()
  git(H, ['update-ref', R.control, sha, head])
  R.head = sha; R.members = members
  push(H, R.control)
  return sha
}
const validateRef = (H: Handle, ref: string, sha: string): void => {
  if (ref.startsWith(TAGS)) {
    const s = signalName(ref)
    const name = refs(H, 'refs/heads/').keys()
    for (const ctl of name) {
      if (!ctl.endsWith('/control')) continue
      const roomName = ctl.slice('refs/heads/'.length, -'/control'.length)
      const head = rev(H, ctl)!
      if (!ancestor(H, s.genesis, head)) continue
      const R = roomData(H, roomName, head)
      if (R.genesis === s.genesis) {
        checkSignal(H, {name: roomName, head, genesis: R.genesis, control: ctl, log: who => `refs/heads/${roomName}/log/${who}`}, ref, sha)
        return
      }
    }
    return C.fail('signal points at no verified room')
  }
  if (ref === 'refs/heads/main') { verifyMain(H, sha); return }
  const ctl = /^refs\/heads\/([^/]+)\/control$/.exec(ref)
  if (ctl && P.ID_RE.test(ctl[1])) { roomData(H, ctl[1], sha); return }
  const log = /^refs\/heads\/([^/]+)\/log\/([^/]+)$/.exec(ref) ?? C.fail('only explicit main, control or own log refs may be pushed')
  if (!P.ID_RE.test(log[1]) || !P.ID_RE.test(log[2])) C.fail('only explicit main, control or own log refs may be pushed')
  const control = `refs/heads/${log[1]}/control`
  const head = rev(H, control) || C.fail('no room control for this log')
  const room = roomData(H, log[1], head)
  verifyLog(H, {name: log[1], head, genesis: room.genesis}, log[2], sha)
}
export const push = (H: Handle, ref: string): void => {
  if (!isRemote(H)) return
  return locked(H, () => {
    // Read the current head after taking the transport lock: an earlier append may have waited behind a newer one.
    const tag = ref.startsWith(TAGS)
    const pin = tag ? TAG_ACCEPT + ref.slice(TAGS.length) : accepted(ref)
    const track = tag ? TAG_TRACK + ref.slice(TAGS.length) : tracking(ref)
    const sha = (tag ? object(H, ref) : rev(H, ref)) || C.fail(`no ${ref} to publish`)
    validateRef(H, ref, sha)
    const url = origin(H)
    if (!url) return // signed source may be provisioned before a remote is attached
    checkUrl(url)
    const acc = tag ? object(H, pin) : rev(H, pin)
    if (acc && (tag ? acc !== sha : !ancestor(H, acc, sha))) C.fail('ref to publish does not extend its accepted transport history')
    const r = git(H, ['push', '-q', '--porcelain', url, `${sha}:${ref}`], {ok: true})
    const alarms = pushAlarms(H)
    if (r.status !== 0) {
      alarms[ref] = `push rejected for ${suffix(ref)}; local commit ${sha.slice(0, 12)} retained; resolve the remote conflict before continuing`
      config(H, 'ringi.pushAlarms', JSON.stringify(alarms))
      C.fail(`ALARM ${alarms[ref]}`)
    }
    delete alarms[ref]; config(H, 'ringi.pushAlarms', JSON.stringify(alarms))
    git(H, ['update-ref', pin, sha, acc || zero(H)])
    git(H, ['update-ref', track, sha])
  })
}

// Only the operator command calls this after reviewing an alarm. Signature checks are never waived.
export const forget = (H: Handle, R: Room, who: string): void => {
  if (!isRemote(H)) return
  id(who)
  const ref = R.log(who)
  return locked(H, () => {
    const sha = rev(H, tracking(ref))
    if (sha) verifyLog(H, R, who, sha)
    const old = rev(H, ref)
    if (old) git(H, ['update-ref', `refs/ringi/quarantine/${R.genesis}/${who}/${old}`, old])
    git(H, ['update-ref', '-d', accepted(ref)])
    if (sha) git(H, ['update-ref', ref, sha, old || zero(H)])
    else if (old) git(H, ['update-ref', '-d', ref, old])
    const alarms = pushAlarms(H); delete alarms[ref]; config(H, 'ringi.pushAlarms', JSON.stringify(alarms))
    if (H.remoteAlarms) delete H.remoteAlarms[ref]
  })
}
