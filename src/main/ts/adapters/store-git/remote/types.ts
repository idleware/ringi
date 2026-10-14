// types: what the signed transport's modules share: the hub handle, a room, keys, signers, a verified branch.

import type {Descriptor, Member, RoomEndpoint} from '../../../core/hub/ports/store.ts'
import type {SigningContext} from '../../../core/signing/index.ts'
import type {TransportAuth} from '../auth.ts'

export type Handle = {name: string, dir: string, d: Descriptor, endpoint?: RoomEndpoint, signing?: SigningContext, auth?: TransportAuth, main?: string, remoteAlarms?: Record<string, string>, heartbeatErrors?: Record<string, string>, bootstrap?: boolean}

// A room: its one branch (`ref`), its latest control record (`head`) and its genesis.
export type Room = {name: string, ref: string, head: string, genesis: string, members?: Record<string, Member>}

export type Key = {line: string, fp: string}

export type Signer = {principal: string, key: Key}

export type VerifiedRoom = {genesis: string, entries: Signer[], members: Record<string, Member>}

// A room's branch as verified up to a tip: its control records in order, the admitted author of each valid message,
// and why each other commit is skipped.
export type Branch = VerifiedRoom & {subject: string, control: string[], authors: Map<string, string>, skipped: Map<string, string>}

export const CONTROL_FILES = ['ROOM.md', 'members.json', 'profile.json', 'allowed_signers']

export type CommandOpt = {input?: string | Buffer, env?: NodeJS.ProcessEnv, ok?: boolean, raw?: boolean, sshAccess?: boolean}

export const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

export const ROOT = 'operator'

export const TRACK = 'refs/remotes/origin/'

export const ACCEPT = 'refs/ringi/remote-accepted/'

export type Commit = {sha: string, parents: string[]}

// Commits read raw, without trusting any separator inside them: parents, author name and message text.
export type Raw = {sha: string, parents: string[], author: string, committer: string, tree: string, time: number, text: string, body: Buffer}
