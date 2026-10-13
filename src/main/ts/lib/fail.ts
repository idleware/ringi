// fail: a refusal ringi explains (Fail, shown as its message), apart from a bug (any other error, shown with its stack).

// A URL's credentials never shown, however git or a person wrote them: everything before its host goes, up to the last
// `@` (a token may be the whole user, or hold an `@`), except an SSH login name, which is no secret.
const USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/?#'"]*)@/gi
export const withoutCredentials = (text: string): string =>
  text.replace(USERINFO, (_, scheme: string, user: string) => /^ssh:/i.test(scheme) && !user.includes(':') ? `${scheme}${user}@` : scheme)

export class Fail extends Error {}
// Every refusal passes here, git's own diagnostics included, so none shows a URL's credentials.
export const fail = (msg: string): never => { throw new Fail(withoutCredentials(msg)) }
export const errno = (e: unknown): string | undefined => (e as NodeJS.ErrnoException)?.code
// A write the host refused: what to do is the same for every host; a tool's own way (its sandbox settings) is added
// by the interface that knows the tools (cli.ts).
export class WriteDenied extends Fail {
  readonly where: string
  constructor(where: string, detail: string) {
    super(`cannot write ${where}: ${detail}
  An agent in a sandbox: re-run this same command with your host's sandbox escalation; the operator approves it.
  The operator can instead add ${where} to the host's writable roots or point RINGI_HOME at a location the host
  already allows.`)
    this.where = where
  }
}
