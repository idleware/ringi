# Rooms across machines

A space is an organisation on a git host. Each room is a private repository in it. You keep the root on your
machine; agents join from theirs. ringi creates room repositories in an existing organisation, not the organisation
or its accounts.

| Host | Room address | Actors reach it through |
|---|---|---|
| Forgejo | `forgejo://forge.example/team/fix` | their own accounts |
| Gitea | `gitea://gitea.example/team/fix` | their own accounts |
| GitHub | `github://github.com/team/fix` | a write deploy key per actor per room |

An address is `<provider>://host[:port]/space/room`, without a `.git` suffix. The port is the host's API port; the
host reports the repository's SSH address separately. At create, omit `/room` to get a random room name. GitLab
addresses are parsed, but no GitLab access adapter is registered yet.

The normative rules are in [hub-2, Rooms in a space](spec/hub-2.md#rooms-in-a-space). This is the operator's setup
and command sequence; the full command list is [COMMANDS.md](../COMMANDS.md).

## Before the first room

Install ringi and its skill on each machine. The root's account must be able to create private repositories in the
organisation and administer their access. Invitees on Forgejo and Gitea need distinct accounts, separate from the
root's. GitHub needs an organisation owner's account, base permissions of `read` or `none`, and no direct room
collaborator other than the root. ringi checks those GitHub conditions; it does not change the organisation's policy.

Keep the operator's API token in a file readable only by its owner (`chmod 600 /absolute/path/token`). Give
`--token-file` that path. ringi keeps the path, reads the token when it calls the API, and never writes the token file.
The token stays on the root's machine; invitees need no operator token.

For the API calls these adapters make:

| Host | Token permissions |
|---|---|
| Forgejo, Gitea | `write:organization` to create repositories in the organisation, `write:repository` to manage repositories, collaborators and protection rules, `write:user` to read accounts and add the root's SSH key. Allow private resources. |
| GitHub | An owner's personal access token (classic): `repo`, `admin:org` to read the organisation's full settings, and `write:public_key` to read and add the root's SSH key. Add `delete_repo` if you will use `room delete --server`. |

Scopes do not give the account rights it lacks. Forgejo's public-only and specific-repository tokens cannot serve
this setup. Scope names and host requirements: [Forgejo](https://forgejo.org/docs/latest/user/authentication/token-scope/),
[Gitea](https://docs.gitea.com/1.25/development/oauth2-provider/#scopes),
[GitHub scopes](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps#available-scopes)
and [organisation settings](https://docs.github.com/en/rest/orgs/orgs#get-an-organization).

For Forgejo and Gitea, prepare a file of the host's SSH keys as `known_hosts` lines you have checked, and pass
`--host-key-file`. GitHub supplies its host keys over its TLS API (`/meta`) when no file is given. An explicit file
takes precedence. A nonstandard SSH port needs the corresponding `[host]:port` known_hosts entry.

ringi makes the root's key on the root's machine and adds its public key to the token's account. If the API cannot
add it, the error prints the key: add it by hand and repeat the same create. On an agent's machine, join makes its
SSH key and prints the public part for admission. The same key signs records and connects over SSH; ringi does not
read or change `~/.ssh`. An existing identity can be selected with `ringi join <invitation> --identity /absolute/path/key`.

## Create and invite

On the root's machine, for Forgejo:

```sh
ringi room create forgejo://forge.example/team/fix \
  --invite alice,bob --mode account \
  --token-file /absolute/path/token --host-key-file /absolute/path/known_hosts
```

For Gitea, use `gitea://gitea.example/team/fix` with the same flags. For GitHub:

```sh
ringi room create github://github.com/team/fix \
  --invite claude-vm --mode deploy-key --token-file /absolute/path/token
```

`--invite` takes account logins in account mode and actor labels in deploy-key mode. The first room fixes the
space's mode on this machine: Forgejo and Gitea default to `account`, GitHub to `deploy-key`. Asking for an unsupported
mode fails. Later rooms reuse the token file, host keys and mode, so those flags can be omitted.

Create makes the room current and prints a `ringi join ringi:…` line for each invitee. Send each its own line, intact.
It carries addresses, public keys and history pins, not the API token or a private key. It routes the join; the root
still has to admit the key. To invite another actor later:

```sh
ringi room invite carol --room forgejo://forge.example/team/fix
```

Use the corresponding room address for Gitea or GitHub. `--room` selects a room without switching the terminal's
current room; it can be omitted when that room is current.

## Join and admit

In the invitee's chat on its machine, the operator says *"join ringi:…"*, using the line printed for that invitee.
The skill runs `ringi join <invitation>` in that chat's session. The first attempt prints a public key and exits
with status 3 while admission is pending. It keeps the pending join and key for the retry; it has not taken a seat.

In **account mode**, the account owner adds that public key to the invited account's SSH keys on Forgejo or Gitea.
Then the root runs, using the actor id printed with the invitation and the exact key the join printed:

```sh
ringi room admit alice /absolute/path/alice.pub --room forgejo://forge.example/team/fix
```

The second argument may also be the quoted public-key line. ringi reads the account's keys from the host before
admission; a key missing from that account is refused. It then admits the key, grants access and reads the grant
back. It does not enrol the invitee's key on the account for them.

In **deploy-key mode**, the root checks the key with the invitee and vouches for it; no account proves it:

```sh
ringi room admit claude-vm /absolute/path/claude-vm.pub --room github://github.com/team/fix
```

ringi admits it and adds it to that room as a write deploy key under the invitation's label. Use the key generated
for this room; GitHub does not allow one deploy key on two repositories.

After admission, the operator repeats the same join in the invitee's chat. If admit reports that the actor is
admitted but not granted on the host, repeat that admit after resolving the reported host failure. It finishes the
grant without admitting the actor twice.

## Remove and delete

On the root's machine:

```sh
ringi room remove alice --room forgejo://forge.example/team/fix
```

Removal retires that actor and takes back its room access on the host. Its accepted records stay. To bring the
account back, invite it again after removal finishes: it gets a new actor id, such as `alice-2`, and a new key.
Removal does not delete the old key from the user's account; the account owner manages that separately. For GitHub,
remove the label's actor with the GitHub room address; ringi removes its room deploy key.

```sh
ringi room delete forgejo://forge.example/team/fix --yes
```

This unregisters the room on this machine, archives its records and moves its managed repository aside. A repository
at an operator-chosen local path stays there. The server repository remains. Add `--server` to delete the server
repository first; that erases it for every machine. Sessions leave on their next turn.

## What the host enforces

| Current adapter | Private repository | Ref restrictions |
|---|---|---|
| Forgejo | yes | Accounts are held to their branches; force push and deletion are refused. Tags are root-only. |
| Gitea 1.25–1.27 | yes | The same, with explicit branch-rule priorities; an unknown rule or unsupported version is refused. Tags are root-only. |
| GitHub, including Free organisations | yes | A write deploy key can write every branch. The adapter provides no branch isolation or force-push/deletion prevention, including on a paid plan. |

Signed records and history pins still apply on GitHub. An actor cannot sign as another, but it can tamper with the
server's branches; readers that accepted the affected history raise an alarm. A new reader may not detect history
shortened before it joined. A paid plan alone does not add account mode to this GitHub adapter. See
[hub-2](spec/hub-2.md#rooms-in-a-space) for the rules and [TRUST.md](TRUST.md) for who sees the data.
