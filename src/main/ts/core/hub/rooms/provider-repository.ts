// Provider incarnations survive local retries. A name, public marker or empty repository confers no ownership.
import {fail} from '../../../lib/index.ts'
import type {RoomProvision} from '../ports/access.ts'

export type ProviderRepository = {id: unknown, address: unknown, private: unknown}
type Read = () => Promise<ProviderRepository | null>
type Source = {read: Read, create(): Promise<ProviderRepository | null>, hasChat(): Promise<boolean>, label: string, privateError: string}
export const repositoryId = (id: unknown): string => {
  if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) return String(id)
  if (typeof id === 'string' && /^[1-9][0-9]{0,39}$/.test(id)) return id
  return fail('provider returned no stable repository id; nothing is adopted or deleted')
}
export const sameRepository = (repo: {id?: unknown}, expected: string): void => {
  if (repositoryId(repo.id) !== repositoryId(expected)) fail('provider repository id changed; nothing is adopted or deleted')
}
// The successful creation response is the only first binding. An interruption before its durable bind requires
// explicit operator recovery; an automatic retry never guesses who created an unknown existing object.
// The provider is trusted: this guards collisions and replacement objects, not a hostile host or organization owner.
export const provisionRepository = async (source: Source, intent: RoomProvision) => {
  let repo = await source.read()
  if (repo && repo.private !== true) fail(source.privateError)
  if (repo) {
    const expected = intent.repositoryId ?? fail(`${source.label} exists on the host and is not this room's saved repository; nothing is adopted; if an interrupted create of yours made it, delete it on the host and create again`)
    sameRepository(repo, expected)
  } else {
    if (intent.repositoryId) fail(`${source.label} lost its saved repository; no replacement is created`)
    repo = await source.create() ?? fail('provider returned no created repository')
  }
  const id = repositoryId(repo.id)
  if (repo.private !== true || typeof repo.address !== 'string') return fail(`${source.label} has no private repository address`)
  const address = repo.address
  intent.bind({address, repositoryId: id})
  const current = await source.read() ?? fail('created repository disappeared before policy changes')
  sameRepository(current, id)
  if (current.private !== true || current.address !== address) fail('provider repository address or privacy changed before policy changes')
  if (await source.hasChat()) intent.checkChat()
  return {address, repositoryId: id}
}
export const checkServerDelete = async (read: Read, expected: string): Promise<boolean> => {
  repositoryId(expected)
  const repo = await read()
  if (!repo) return false
  sameRepository(repo, expected)
  return true
}
