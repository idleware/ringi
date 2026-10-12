// fail: a refusal ringi explains (Fail, shown as its message), apart from a bug (any other error, shown with its stack).

export class Fail extends Error {}
export const fail = (msg: string): never => { throw new Fail(msg) }
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
