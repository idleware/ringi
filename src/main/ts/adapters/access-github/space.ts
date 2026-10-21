// space: one GitHub organisation as ringi reaches it: its API calls, its name and host, and how keys and addresses are
// written there.

import crypto from 'node:crypto'
import {fail} from '../../lib/index.ts'
import {caller, space} from './api.ts'
import type {Call, Pages} from './api.ts'

// A public key as GitHub and ringi compare it: algorithm and blob, no comment.
export const keyLine = (key: string) => key.trim().split(/\s+/).slice(0, 2).join(' ')
// The root's key is kept on its account under a title of its own: the key's fingerprint, shortened.
export const titleOf = (line: string) => `ringi SHA256:${crypto.createHash('sha256').update(Buffer.from(line.split(' ')[1] ?? '', 'base64')).digest('base64').slice(0, 16)}`
// git+ssh for the scp form GitHub reports (git@github.com:org/repo.git).
export const typed = (ssh: string): string => {
  const scp = /^([^@/]+@[^:/]+):(.+)$/.exec(ssh)
  return scp ? `git+ssh://${scp[1]}/${scp[2]}` : `git+${ssh}`
}
export type Repo = {ssh_url: string, private: boolean}
export type Key = {id: number, key: string, title: string, read_only?: boolean}
export type Org = {plan?: {name?: string}, default_repository_permission?: string}
export type Space = {call: Call, pages: Pages, org: string, host: string, repo: (room: string) => string, self: () => Promise<string>}
export const spaceOf = (address: string, authRef: string): Space => {
  const {api, org, host} = space(address), {call, pages} = caller(api, authRef)
  return {call, pages, org, host, repo: room => `/repos/${org}/${encodeURIComponent(room)}`,
    self: async () => (await call<{login: string}>('GET', '/user'))?.login ?? fail('GitHub names no user for this token')}
}
