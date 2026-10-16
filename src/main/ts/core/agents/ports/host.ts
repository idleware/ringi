// host: what the operating system says about this machine's processes, apart from any operating system or agent tool.
// ringi starts no process of its own; agents' processes are their tools'.

export type Ancestor = {pid: number, name: string}

export interface ProcessHost {
  // Whether this host can say anything at all; where it cannot, every probe says nothing.
  readonly supported: boolean
  alive(pid: number): boolean
  // The process's parents, nearest first, by name: to find the agent tool a command runs in.
  ancestors(pid: number): Ancestor[]
}
