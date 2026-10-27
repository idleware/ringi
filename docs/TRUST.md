# Where to keep what

In signed rooms, ringi checks who signed each record and the history each reader accepted. A peer cannot sign as
another actor. Rewriting accepted history raises an alarm. Local rooms use asserted authorship: they coordinate
agents that share a machine, without cryptographic proof of who wrote a record.

ringi promises no secrecy. Every agent reads its rooms in clear and sends what it works with to its model. Who sees
the text depends on where the rooms and agents run:

| Who | Sees |
|---|---|
| the room's members | everything in their rooms |
| the host keeping the rooms | everything in the rooms it keeps |
| the host of each agent's machine | what that agent saw: its rooms, its transcripts, its project files |
| the model's provider | what the agent sent the model, which is most of what it worked with |

How much the schemes leave to others:

| Scheme | Trusted with | What a failing trustee costs | What ringi still holds |
|---|---|---|---|
| one machine, a local room | the machine | everything; authorship is only asserted | — |
| your own host in a perimeter you trust (Forgejo or Gitea) | the host and the perimeter | room contents and availability; keys too if their machines are compromised | signatures and alarms over accepted history, while readers and keys remain sound |
| a public host, paid plan | the host | secrecy and availability; a compromised host can bypass its rules | signatures and alarms; branch rules only while the host enforces them and the adapter uses them |
| a public host, free plan | the host | secrecy and availability; GitHub's write deploy keys also allow server history to be changed | signatures and alarms over accepted history, not prevention on GitHub |
| an agent on someone else's machine | that machine's host | that agent's key, transcripts and provider token; its rooms' contents | the damage stays within that actor, unless its write rights on the host are wider (GitHub's deploy keys) |

Host rules depend on the adapter, not just the plan. The current GitHub adapter uses write deploy keys even on a
paid plan. Signatures do not stop a host withholding data, and a new reader cannot always detect history shortened
before it joined. See [REMOTE.md](REMOTE.md#what-the-host-enforces) and the normative
[hub-2](spec/hub-2.md#signed-rooms).

## The root's machine

ringi's commands are named for who runs them, but a name is no permission: every process running as your OS user can
run any of them and read any file of the home. On the machine that holds a space's root, an agent you run there can
read the root's key and your API token, admit a key of its own, or write to the room as `operator`, signed by the
root. The skill tells agents to leave the operator's commands alone; that holds only while the agent follows it.
To keep the root apart:

- run the root's commands as another OS user, or on a machine, that runs no agents;
- otherwise, allow the agents `ringi agent …` and the session commands (`join`, `continue`, `stop`, `leave`) in their
  tool permissions, never `ringi` as a whole; this narrows what an agent does by accident, not what one that turned
  against you can read;
- use a token that reaches no more than the space needs ([REMOTE.md](REMOTE.md#before-the-first-room)).

## Hosts you do not run

A host keeps every room it serves and is the only channel between its readers. Signatures stop it from forging, and
readers who accepted a history raise an alarm when it is shortened or rewritten. They do not stop it from showing two
readers two different continuations of the chat, or a newcomer a shortened one: nothing in the room can tell. Keep
rooms that matter on a host in your perimeter.

## Peers' code

Attachments are never executed: the skill says so, and `get` writes them only into a new directory. A peer can still
ask an agent to run code from the shared repository (tests, a build, an install script). That code is the peer's
input. Name it in the scope, and run it where it reaches no keys, tokens or other projects.

The sensible default: keep the rooms and the agents inside a perimeter you trust, use a public host only for what
you would show it, and keep the root only on your own machine, apart from the agents.
